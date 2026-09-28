import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as dbSchema from "@paperclipai/db";
import {
  agents,
  companies,
  costEvents,
  createDb,
  goals,
  issueComments,
  issues,
  projectGoals,
  projects,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { COMPANY_TEARDOWN_TABLES, companyService } from "../services/companies.js";

/**
 * A foreign key only blocks a delete when it is NO ACTION / RESTRICT. CASCADE and
 * SET NULL references are resolved by Postgres for us.
 */
function isBlocking(onDelete: string | undefined): boolean {
  return !onDelete || onDelete === "no action" || onDelete === "restrict";
}

type TableInfo = { name: string; exportName: string; blockingDeps: Set<string> };

function collectSchemaTables(): Map<string, TableInfo> {
  const tables = new Map<string, TableInfo>();
  for (const [exportName, value] of Object.entries(dbSchema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    const blockingDeps = new Set<string>();
    for (const foreignKey of config.foreignKeys) {
      const target = getTableConfig(foreignKey.reference().foreignTable).name;
      if (target === config.name) continue;
      if (isBlocking((foreignKey as { onDelete?: string }).onDelete)) blockingDeps.add(target);
    }
    tables.set(config.name, { name: config.name, exportName, blockingDeps });
  }
  return tables;
}

/**
 * Every table that holds a blocking reference into the company graph — directly or
 * transitively — has to be emptied before `companies` can be deleted.
 */
function collectRequiredTables(tables: Map<string, TableInfo>): Set<string> {
  const required = new Set<string>(["companies"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const table of tables.values()) {
      if (required.has(table.name)) continue;
      for (const dep of table.blockingDeps) {
        if (required.has(dep)) {
          required.add(table.name);
          changed = true;
          break;
        }
      }
    }
  }
  required.delete("companies");
  return required;
}

describe("COMPANY_TEARDOWN_TABLES", () => {
  const schemaTables = collectSchemaTables();
  const required = collectRequiredTables(schemaTables);
  const listed = COMPANY_TEARDOWN_TABLES.map((table) => getTableConfig(table).name);

  it("covers every table that blocks deleting a company", () => {
    const missing = [...required]
      .filter((name) => !listed.includes(name))
      .map((name) => schemaTables.get(name)?.exportName ?? name)
      .sort();

    expect(
      missing,
      `COMPANY_TEARDOWN_TABLES is missing ${missing.length} table(s) that hold blocking ` +
        "foreign keys into the company graph. Deleting a company with rows in them fails " +
        "with a foreign key violation at runtime. Add them to the list in the right order.",
    ).toEqual([]);
  });

  it("lists every table before the tables it points at", () => {
    const positionOf = new Map(listed.map((name, index) => [name, index]));
    const violations: string[] = [];

    for (const name of listed) {
      const info = schemaTables.get(name);
      if (!info) continue;
      for (const dep of info.blockingDeps) {
        const depPosition = positionOf.get(dep);
        if (depPosition === undefined) continue;
        if (depPosition < positionOf.get(name)!) {
          violations.push(`${info.exportName} must be deleted before ${schemaTables.get(dep)?.exportName ?? dep}`);
        }
      }
    }

    expect(violations, "COMPANY_TEARDOWN_TABLES is ordered wrongly").toEqual([]);
  });

  it("only lists company-scoped tables", () => {
    const notScoped = COMPANY_TEARDOWN_TABLES.map((table) => getTableConfig(table))
      .filter((config) => !config.columns.some((column) => column.name === "company_id"))
      .map((config) => config.name);

    expect(notScoped).toEqual([]);
  });

  it("does not list the same table twice", () => {
    expect(listed).toEqual([...new Set(listed)]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company removal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService.remove", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-remove-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes a company that has goals, projects, routines, issues and comments", async () => {
    const service = companyService(db);
    const company = await service.create({ name: "Teardown Test Co" });

    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "CEO",
        role: "ceo",
        adapterType: "claude_local",
        adapterConfig: {},
      })
      .returning();

    const [goal] = await db
      .insert(goals)
      .values({
        companyId: company.id,
        title: "Ship the thing",
        level: "company",
        ownerAgentId: agent.id,
      })
      .returning();

    // projects.goal_id -> goals.id is NO ACTION, so goals must not be deleted first.
    const [project] = await db
      .insert(projects)
      .values({
        companyId: company.id,
        name: "Primary",
        goalId: goal.id,
        leadAgentId: agent.id,
      })
      .returning();

    await db.insert(projectGoals).values({
      companyId: company.id,
      projectId: project.id,
      goalId: goal.id,
    });

    // routines.assignee_agent_id -> agents.id is NO ACTION, so agents must not be
    // deleted while a routine still points at them.
    await db.insert(routines).values({
      companyId: company.id,
      projectId: project.id,
      goalId: goal.id,
      title: "Weekly review",
      assigneeAgentId: agent.id,
      schedule: { kind: "cron", expression: "0 9 * * 1", timezone: "UTC" },
    });

    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        projectId: project.id,
        goalId: goal.id,
        identifier: "TTC-1",
        title: "First issue",
        status: "todo",
        assigneeAgentId: agent.id,
        createdByAgentId: agent.id,
      })
      .returning();

    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorType: "agent",
      authorAgentId: agent.id,
      body: "Working on it.",
    });

    await db.insert(costEvents).values({
      companyId: company.id,
      agentId: agent.id,
      projectId: project.id,
      goalId: goal.id,
      issueId: issue.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      costCents: 42,
      occurredAt: new Date(),
    });

    const removed = await service.remove(company.id);
    expect(removed?.id).toBe(company.id);

    await expect(
      db.select().from(companies).where(eq(companies.id, company.id)),
    ).resolves.toEqual([]);
    await expect(
      db.select().from(projects).where(eq(projects.companyId, company.id)),
    ).resolves.toEqual([]);
    await expect(
      db.select().from(goals).where(eq(goals.companyId, company.id)),
    ).resolves.toEqual([]);
    await expect(
      db.select().from(agents).where(eq(agents.companyId, company.id)),
    ).resolves.toEqual([]);
    await expect(
      db.select().from(routines).where(eq(routines.companyId, company.id)),
    ).resolves.toEqual([]);
    await expect(
      db.select().from(issues).where(eq(issues.companyId, company.id)),
    ).resolves.toEqual([]);
  }, 60_000);

  it("deletes a company with no related rows", async () => {
    const service = companyService(db);
    const company = await service.create({ name: "Empty Co" });

    await expect(service.remove(company.id)).resolves.toMatchObject({ id: company.id });
    await expect(
      db.select().from(companies).where(eq(companies.id, company.id)),
    ).resolves.toEqual([]);
  }, 60_000);
});
