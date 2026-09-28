import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as dbSchema from "@paperclipai/db";
import {
  activityLog,
  agentApiKeys,
  agents,
  approvals,
  companies,
  costEvents,
  createDb,
  financeEvents,
  goals,
  heartbeatRuns,
  issues,
  projects,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { AGENT_REFERENCE_POLICIES, agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";

function isBlocking(onDelete: string | undefined): boolean {
  return !onDelete || onDelete === "no action" || onDelete === "restrict";
}

/** Every `table.column` with a blocking foreign key to `agents`. */
function collectBlockingAgentReferences(): Set<string> {
  const refs = new Set<string>();
  for (const value of Object.values(dbSchema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      if (getTableConfig(reference.foreignTable).name !== "agents") continue;
      if (!isBlocking((foreignKey as { onDelete?: string }).onDelete)) continue;
      for (const column of reference.columns) {
        refs.add(`${config.name}.${column.name}`);
      }
    }
  }
  return refs;
}

describe("AGENT_REFERENCE_POLICIES", () => {
  const required = collectBlockingAgentReferences();
  const covered = AGENT_REFERENCE_POLICIES.map(
    (policy) => `${getTableConfig(policy.table).name}.${policy.column.name}`,
  );

  it("covers every column that blocks deleting an agent", () => {
    const missing = [...required].filter((ref) => !covered.includes(ref)).sort();

    expect(
      missing,
      `AGENT_REFERENCE_POLICIES is missing ${missing.length} reference(s) with blocking ` +
        "foreign keys to agents. Deleting an agent that owns rows in them fails with a " +
        "foreign key violation at runtime. Add each one with an explicit detach/delete policy.",
    ).toEqual([]);
  });

  it("does not declare policies for references that do not exist", () => {
    const stale = covered.filter((ref) => !required.has(ref)).sort();
    expect(stale).toEqual([]);
  });

  it("nulls out only nullable columns", () => {
    const badDetach = AGENT_REFERENCE_POLICIES.filter((policy) => policy.action === "detach")
      .filter((policy) => policy.column.notNull)
      .map((policy) => `${getTableConfig(policy.table).name}.${policy.column.name}`);

    expect(badDetach, "a NOT NULL column cannot be detached, it has to be deleted").toEqual([]);
  });

  it("deletes heartbeat runs last so dependent rows are gone first", () => {
    const deletes = AGENT_REFERENCE_POLICIES.filter((policy) => policy.action === "delete");
    const last = deletes.at(-1);
    expect(last && getTableConfig(last.table).name).toBe("heartbeat_runs");
  });

  it("applies every detach before any delete", () => {
    const firstDelete = AGENT_REFERENCE_POLICIES.findIndex((policy) => policy.action === "delete");
    const lastDetach = AGENT_REFERENCE_POLICIES.map((policy) => policy.action).lastIndexOf("detach");
    expect(lastDetach).toBeLessThan(firstDelete);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent removal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentService.remove", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const company = await companyService(db).create({ name });
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Doomed",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      })
      .returning();
    return { company, agent };
  }

  it("deletes an agent that owns a routine, a project and a goal", async () => {
    const { company, agent } = await seedCompany("Agent Teardown Co");

    const [report] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Report",
        role: "qa",
        reportsTo: agent.id,
        adapterType: "claude_local",
        adapterConfig: {},
      })
      .returning();

    const [goal] = await db
      .insert(goals)
      .values({ companyId: company.id, title: "Owned goal", level: "company", ownerAgentId: agent.id })
      .returning();

    const [project] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Led project", leadAgentId: agent.id })
      .returning();

    // routines.assignee_agent_id -> agents.id is NO ACTION: this is what used to 500.
    const [routine] = await db
      .insert(routines)
      .values({
        companyId: company.id,
        title: "Daily standup",
        assigneeAgentId: agent.id,
        status: "active",
        schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      })
      .returning();

    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: "ATC-1",
        title: "Assigned work",
        status: "todo",
        assigneeAgentId: agent.id,
        createdByAgentId: agent.id,
      })
      .returning();

    await db.insert(approvals).values({
      companyId: company.id,
      type: "agent_hire",
      status: "pending",
      requestedByAgentId: agent.id,
      payload: {},
    });

    const removed = await agentService(db).remove(agent.id);
    expect(removed?.id).toBe(agent.id);

    // The agent is gone.
    await expect(db.select().from(agents).where(eq(agents.id, agent.id))).resolves.toEqual([]);

    // Soft references survive with the link dropped.
    const [keptRoutine] = await db.select().from(routines).where(eq(routines.id, routine.id));
    expect(keptRoutine.assigneeAgentId).toBeNull();
    expect(keptRoutine.status).toBe("paused");

    const [keptIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(keptIssue.assigneeAgentId).toBeNull();
    expect(keptIssue.createdByAgentId).toBeNull();

    const [keptProject] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(keptProject.leadAgentId).toBeNull();

    const [keptGoal] = await db.select().from(goals).where(eq(goals.id, goal.id));
    expect(keptGoal.ownerAgentId).toBeNull();

    const [keptReport] = await db.select().from(agents).where(eq(agents.id, report.id));
    expect(keptReport.reportsTo).toBeNull();

    const [keptApproval] = await db.select().from(approvals).where(eq(approvals.companyId, company.id));
    expect(keptApproval.requestedByAgentId).toBeNull();
  }, 60_000);

  it("deletes an agent with heartbeat runs, cost events and a finance ledger entry", async () => {
    const { company, agent } = await seedCompany("Agent Ledger Co");

    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: agent.id, status: "completed", trigger: "schedule" })
      .returning();

    const [costEvent] = await db
      .insert(costEvents)
      .values({
        companyId: company.id,
        agentId: agent.id,
        heartbeatRunId: run.id,
        provider: "anthropic",
        model: "claude-sonnet-4",
        costCents: 17,
        occurredAt: new Date(),
      })
      .returning();

    // finance_events keeps blocking references to the agent, its run AND its cost event.
    const [financeEvent] = await db
      .insert(financeEvents)
      .values({
        companyId: company.id,
        agentId: agent.id,
        heartbeatRunId: run.id,
        costEventId: costEvent.id,
        eventKind: "llm_usage",
        biller: "anthropic",
        amountCents: 17,
        occurredAt: new Date(),
      })
      .returning();

    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "agent",
      actorId: agent.id,
      agentId: agent.id,
      runId: run.id,
      action: "heartbeat.completed",
      entityType: "agent",
      entityId: agent.id,
    });

    await db.insert(agentApiKeys).values({
      companyId: company.id,
      agentId: agent.id,
      name: "default",
      keyHash: "deadbeef",
    });

    await expect(agentService(db).remove(agent.id)).resolves.toMatchObject({ id: agent.id });

    // Agent-owned telemetry is gone.
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id))).resolves.toEqual([]);
    await expect(db.select().from(costEvents).where(eq(costEvents.id, costEvent.id))).resolves.toEqual([]);
    await expect(
      db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agent.id)),
    ).resolves.toEqual([]);

    // The ledger entry survives, unlinked.
    const [keptFinanceEvent] = await db
      .select()
      .from(financeEvents)
      .where(eq(financeEvents.id, financeEvent.id));
    expect(keptFinanceEvent).toBeDefined();
    expect(keptFinanceEvent.agentId).toBeNull();
    expect(keptFinanceEvent.heartbeatRunId).toBeNull();
    expect(keptFinanceEvent.costEventId).toBeNull();
    expect(keptFinanceEvent.amountCents).toBe(17);
  }, 60_000);

  it("still deletes a company after one of its agents was deleted", async () => {
    const { company, agent } = await seedCompany("Agent Then Company Co");
    await db
      .insert(routines)
      .values({
        companyId: company.id,
        title: "Weekly review",
        assigneeAgentId: agent.id,
        status: "active",
        schedule: { kind: "cron", expression: "0 9 * * 1", timezone: "UTC" },
      });

    await expect(agentService(db).remove(agent.id)).resolves.toMatchObject({ id: agent.id });
    await expect(companyService(db).remove(company.id)).resolves.toMatchObject({ id: company.id });
    await expect(db.select().from(companies).where(eq(companies.id, company.id))).resolves.toEqual([]);
  }, 60_000);
});
