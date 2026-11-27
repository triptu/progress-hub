import { expect, test } from "bun:test";
import { diffOf, headline, statements, type Diff } from "../src/core/ddl.ts";

/** A diff as lines a person reads: each table with its mark and rows, then the other objects. */
function lines(diff: Diff): string[] {
  const row = (r: { mark: string; kind: string; name: string; detail: string; tags: readonly string[]; from?: string }) => [r.mark, r.kind, r.from ? `${r.from} → ${r.name}` : r.name, r.detail, r.tags.join(", ")].filter(Boolean).join(" | ");
  return [
    ...diff.tables.flatMap((table) => [`${table.mark}${table.rebuilt ? " rebuilt" : ""} table ${table.from ? `${table.from} → ` : ""}${table.name}`, ...table.rows.map((r) => `  ${row(r)}`)]),
    ...diff.objects.map(row),
  ];
}

test("a Postgres migration: a table, a function with a ; in its body, its trigger, and an index made concurrently on part of a table", () => {
  const sql = `-- One row per conflict; phones settle them later.
CREATE TABLE public.sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  "base version" integer NOT NULL,
  note text DEFAULT 'it''s; fine',
  CONSTRAINT conflicts_version_positive CHECK ("base version" > 0)
);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  NEW.updated_at := now(); /* a ; in a comment */
  RETURN NEW;
END;
$body$;

CREATE TRIGGER sync_conflicts_touch BEFORE UPDATE ON sync_conflicts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX CONCURRENTLY IF NOT EXISTS sync_conflicts_open_idx ON sync_conflicts USING btree (note_id, created_at DESC) WHERE settled_at IS NULL;
CREATE TYPE conflict_state AS ENUM ('open', 'settled');
DO $$ BEGIN RAISE NOTICE 'done; really'; END $$;`;
  expect(lines(diffOf(sql))).toEqual([
    "added table sync_conflicts",
    "  added | column | id | uuid | primary key, default gen_random_uuid()",
    "  added | column | note_id | uuid | not null, → notes(id), on delete cascade",
    "  added | column | base version | integer | not null",
    "  added | column | note | text | default 'it''s; fine'",
    "  added | constraint | conflicts_version_positive | CHECK (\"base version\" > 0)",
    "  added | trigger | sync_conflicts_touch | before update → touch_updated_at()",
    "  added | index | sync_conflicts_open_idx | (note_id, created_at DESC) | concurrently, where settled_at IS NULL",
    "replaced | function | touch_updated_at | () → trigger | or replace, plpgsql",
    "added | type | conflict_state | as enum ('open', 'settled')",
    "changed | DO block | BEGIN RAISE NOTICE 'done; really'; END",
  ]);
});

test("a Drizzle SQLite migration with breakpoints: a new table, and a table rebuilt to change a column", () => {
  const sql = `CREATE TABLE \`note_terms\` (
	\`note_id\` text NOT NULL,
	\`term\` text NOT NULL,
	PRIMARY KEY(\`note_id\`, \`term\`)
);
--> statement-breakpoint
CREATE INDEX \`note_terms_term_idx\` ON \`note_terms\` (\`term\`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_notes\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`index_version\` integer DEFAULT 2 NOT NULL
);
--> statement-breakpoint
INSERT INTO \`__new_notes\`("id", "index_version") SELECT "id", 2 FROM \`notes\`;--> statement-breakpoint
DROP TABLE \`notes\`;--> statement-breakpoint
ALTER TABLE \`__new_notes\` RENAME TO \`notes\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body); END;`;
  expect(lines(diffOf(sql))).toEqual([
    "added table note_terms",
    "  added | column | note_id | text | not null",
    "  added | column | term | text | not null",
    "  added | constraint | primary key (note_id, term)",
    "  added | index | note_terms_term_idx | (term)",
    "changed rebuilt table notes",
    "  added | trigger | notes_ai | after insert",
    "  kept | column | id | text | primary key, not null",
    "  kept | column | index_version | integer | not null, default 2",
  ]);
});

test("ALTER TABLE with several actions, and the expand pattern: a column added, backfilled and made not null reads as one column", () => {
  const sql = `ALTER TABLE devices ADD COLUMN build text, ADD COLUMN IF NOT EXISTS seen_at timestamptz, DROP COLUMN legacy_client, ALTER COLUMN name TYPE varchar(200) USING name::varchar(200), RENAME COLUMN descr TO description;
UPDATE devices SET build = coalesce(header ->> 'build', 'unknown') WHERE build IS NULL;
ALTER TABLE devices ALTER COLUMN build SET NOT NULL;
ALTER TABLE ONLY devices ADD CONSTRAINT devices_team_fk FOREIGN KEY (team_id) REFERENCES teams(id) NOT VALID;
ALTER TABLE devices VALIDATE CONSTRAINT devices_team_fk;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE old_devices RENAME TO archived_devices;
DROP TABLE IF EXISTS device_log, device_log_2 CASCADE;
DROP INDEX CONCURRENTLY IF EXISTS devices_src_idx;`;
  // What was dropped comes first, among the tables and inside one.
  expect(lines(diffOf(sql))).toEqual([
    "dropped table device_log",
    "dropped table device_log_2",
    "changed table devices",
    "  dropped | column | legacy_client",
    "  added | column | build | text | not null",
    "  added | column | seen_at | timestamptz",
    "  added | constraint | devices_team_fk | foreign key (team_id) → teams(id) | not valid",
    "  changed | column | name | → varchar(200)",
    "  renamed | column | descr → description",
    "  changed | data | set build = coalesce(header ->> 'build', 'unknown') where build is null",
    "  changed | constraint | devices_team_fk | validate",
    "  changed | security | enable row level security",
    "renamed table old_devices → archived_devices",
    "dropped | index | devices_src_idx",
  ]);
  // The headline says what was dropped first: what can't be undone.
  expect(headline(diffOf(sql)).map((part) => `${part.tone}: ${part.text}`)).toEqual([
    "dropped: 2 tables dropped",
    "dropped: 1 column dropped",
    "dropped: 1 index dropped",
    "added: 2 columns added",
    "added: 1 constraint added",
    "changed: 2 columns changed",
    "changed: 1 data change",
    "changed: 1 constraint changed",
    "changed: 1 security change",
    "changed: 1 table renamed",
  ]);
});

test("a SQLite trigger whose body has a CASE … END is one statement, and a virtual table dropped and made again is replaced", () => {
  const sql = `CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN UPDATE stats SET n = CASE WHEN NEW.done THEN n + 1 ELSE n END; DELETE FROM drafts WHERE id = NEW.id; END;
DROP TABLE IF EXISTS search_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE search_fts USING fts5(
  id UNINDEXED,
  title,
  content='',
  tokenize='porter unicode61'
);`;
  expect(statements(sql)).toHaveLength(3);
  const diff = diffOf(sql);
  expect(lines(diff)).toEqual(["replaced table search_fts", "  added | column | id | unindexed", "  added | column | title", "changed table notes", "  added | trigger | notes_au | after update"]);
  expect(diff.tables[0]?.module).toBe("fts5");
  expect(headline(diff).map((part) => part.text)).toEqual(["1 table replaced", "1 trigger added"]);
});

test("a DO block that only guards a statement is read as that statement, marked conditional; one that builds its SQL is a row of its own", () => {
  const guarded = `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.db_calendarevent'::regclass AND attname = 'location') THEN
    ALTER TABLE public.db_calendarevent ADD COLUMN IF NOT EXISTS location text;
  END IF;
END
$$;`;
  expect(lines(diffOf(guarded))).toEqual(["changed table db_calendarevent", "  added | column | location | text | conditional"]);
  const dynamic = `DO $$ DECLARE c text; BEGIN SELECT conname INTO c FROM pg_constraint; EXECUTE format('ALTER TABLE t DROP CONSTRAINT %I', c); END $$;`;
  expect(lines(diffOf(dynamic))).toEqual(["changed | DO block | DECLARE c text; BEGIN SELECT conname INTO c FROM pg_constraint; EXECUTE format('ALTER TABLE t DROP CONSTRAINT %I', c); END"]);
});

test("a rename keeps the table's schema, a quoted default and enum labels stay as written, and an index says what it includes", () => {
  expect(lines(diffOf("ALTER TABLE audit.events RENAME TO history; ALTER TABLE audit.history ADD COLUMN retained boolean;"))).toEqual(["renamed table audit.events → audit.history", "  added | column | retained | boolean"]);
  expect(lines(diffOf("ALTER TABLE t ADD COLUMN note text DEFAULT $$a,  b$$, ADD COLUMN done boolean;"))).toEqual(["changed table t", "  added | column | note | text | default $$a,  b$$", "  added | column | done | boolean"]);
  expect(lines(diffOf("ALTER TYPE state ADD VALUE 'WAIT' BEFORE 'READY';"))).toEqual(["changed | type | state | add value 'WAIT' before 'READY'"]);
  // A $ inside a string opens no $tag$ body.
  expect(lines(diffOf("ALTER TYPE payment ADD VALUE '$5';"))).toEqual(["changed | type | payment | add value '$5'"]);
  expect(lines(diffOf("CREATE INDEX runs_open ON runs (template_id) INCLUDE (created_at, state) WHERE finished_at IS NULL;"))).toEqual(["changed table runs", "  added | index | runs_open | (template_id) | include (created_at, state), where finished_at IS NULL"]);
});
