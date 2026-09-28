import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companySkills, createDb, projects, projectWorkspaces } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company skill import key namespace", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipInstanceId: string | undefined;
  let paperclipHome: string | null = null;
  const cleanupDirs = new Set<string>();

  async function writeSkill(dir: string, slug: string) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${slug}\ndescription: ${slug}\n---\n# ${slug}\n`,
      "utf8",
    );
    return dir;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-import-key-");
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    oldPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-import-key-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all([...cleanupDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldPaperclipInstanceId;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("keeps the company namespace for managed-root imports and hashes project-scanned ones", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-import-key-workspace-"));
    cleanupDirs.add(workspace);

    await db.insert(companies).values({
      id: companyId,
      name: "Import Key Co",
      issuePrefix: `K${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Approved project" });
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "Primary",
      cwd: workspace,
      isPrimary: true,
    });

    const managedSkill = await writeSkill(
      path.join(paperclipHome!, "instances", "default", "skills", companyId, "managed-import"),
      "managed-import",
    );
    const workspaceSkill = await writeSkill(
      path.join(workspace, ".agents", "skills", "scanned-import"),
      "scanned-import",
    );

    const service = companySkillService(db);
    const managed = await service.importFromSource(companyId, managedSkill);
    const scanned = await service.importFromSource(companyId, workspaceSkill);

    // A skill living in the company managed-skills root needs no path
    // disambiguation: its slug is unique there, so it keeps the documented
    // `company/<companyId>/<slug>` key even though the local import path does
    // not stamp `sourceKind: "managed_local"`.
    expect(managed.imported[0]).toMatchObject({
      slug: "managed-import",
      sourceType: "local_path",
      key: `company/${companyId}/managed-import`,
    });

    // Project-scanned skills keep the hashed namespace: the same slug can live
    // under many unrelated workspace directories.
    expect(scanned.imported[0]?.key).toMatch(/^local\/[0-9a-f]{10}\/scanned-import$/);
  }, 30_000);

  it("adopts a legacy hashed row for the same managed directory instead of duplicating it", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Legacy Key Co",
      issuePrefix: `L${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const skillDir = await writeSkill(
      path.join(paperclipHome!, "instances", "default", "skills", companyId, "legacy-import"),
      "legacy-import",
    );
    const legacyKey = `local/${createHash("sha256").update(skillDir).digest("hex").slice(0, 10)}/legacy-import`;
    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: legacyKey,
      slug: "legacy-import",
      name: "legacy-import",
      markdown: "# legacy-import\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });

    const service = companySkillService(db);
    const result = await service.importFromSource(companyId, skillDir);

    // The stored key stays put: agents already reference it, and the company
    // must not end up with two catalog rows for one directory.
    expect(result.imported[0]?.key).toBe(legacyKey);
    // `importFromSource` also seeds the bundled catalog, so count only the
    // rows that point at the imported directory.
    const rows = await db.select().from(companySkills).where(eq(companySkills.sourceLocator, skillDir));
    expect(rows.map((row) => row.key)).toEqual([legacyKey]);
  }, 30_000);
});
