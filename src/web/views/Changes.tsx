import { Fragment } from "react";
import type { ReactNode } from "react";
import { CaretRightIcon, CodeIcon, DatabaseIcon, TableIcon } from "@phosphor-icons/react";
import type { Diff, Mark, ObjectDiff, Row, TableDiff } from "../../core/ddl.ts";
import type { WorkId } from "../../core/types.ts";
import type { ChangeCard, ChangeDay } from "../lib/changes.ts";
import { changeTime, ROW_WORD, tableMark } from "../lib/changes.ts";
import { routeHref } from "../lib/route.ts";
import { clock, exact } from "../lib/time.ts";
import { Avatar, Link, ListHead, PrChip } from "./parts.tsx";
import s from "./Changes.module.css";

/** The gutter's sign for each mark, as a diff writes it, and what it says to a screen reader. */
const SIGN: Record<Mark, { readonly sign: string; readonly label: string }> = {
  added: { sign: "+", label: "Added" },
  dropped: { sign: "−", label: "Dropped" },
  replaced: { sign: "~", label: "Replaced" },
  changed: { sign: "~", label: "Changed" },
  renamed: { sign: "~", label: "Renamed" },
  kept: { sign: "", label: "Kept" },
};

interface ChangesProps {
  /** Null while the list loads. */
  readonly days: readonly ChangeDay[] | null;
  readonly query: string;
  /** The open work, whose changes these are, or null for every work's. */
  readonly scope: WorkId | null;
  /** What sits above the list on a work: the work's head and goal. */
  readonly children?: ReactNode;
}

/**
 * Key changes: each database change in a line of what it does, then a diff of each table, with why and the pull
 * request it is in. The newest first, by the day its pull request merged.
 */
export function Changes(props: ChangesProps) {
  const { days } = props;
  return (
    <div className="wrap">
      {props.children}
      {/* On a work the tab says what this is. */}
      {props.scope === null ? <ListHead title="Key changes" sub="Every work's database migrations, newest first" scoped={false} /> : null}
      <div className={s.list}>
        {days === null ? <p className={s.loading}>Loading changes…</p> : null}
        {days?.map((day) => (
          <section key={day.key} className="day">
            <h2 className="day-head">{day.label}</h2>
            <div className={s.cards}>
              {day.cards.map((card) => (
                <ChangeView key={`${card.change.work} ${card.change.pr}`} card={card} scope={props.scope} />
              ))}
            </div>
          </section>
        ))}
        {days && !days.length ? <p className="nothing">{props.query ? `Nothing matches “${props.query}”.` : "No key changes yet."}</p> : null}
      </div>
    </div>
  );
}

/** A path that breaks at its slashes on a narrow screen, never inside a name. */
const Path = (props: { readonly path: string }) => (
  <>
    {props.path.split("/").map((part, i) => (
      <Fragment key={i}>
        {i > 0 ? (
          <>
            /<wbr />
          </>
        ) : null}
        {part}
      </Fragment>
    ))}
  </>
);

function ChangeView(props: { readonly card: ChangeCard; readonly scope: WorkId | null }) {
  const { change, diff, headline, fresh } = props.card;
  const at = changeTime(change);
  const id = `why-${change.work}-${change.at}`.replace(/[^\w-]/g, "-");
  return (
    <article className={s.card} aria-labelledby={id}>
      <header className={s.head}>
        <h3 className={s.why} id={id}>
          {fresh ? <span className={`unread-dot ${s.fresh}`} role="img" aria-label="New since you last looked" title="New since you last looked" /> : null}
          {change.why}
        </h3>
        {headline.length ? (
          <p className={s.headline}>
            {/* A separator goes with the part after it, so no line ends on one. */}
            {headline.map((part, i) => (
              <Fragment key={part.text}>
                {i > 0 ? " " : null}
                <span className={s.part} data-tone={part.tone}>
                  {i > 0 ? <span className={s.dot}>· </span> : null}
                  {part.text}
                </span>
              </Fragment>
            ))}
          </p>
        ) : null}
        <p className={s.meta}>
          {props.scope === null ? (
            <Link href={routeHref({ work: change.work, tab: "changes" })} className={s.from}>
              <Avatar project={change.project} fallback={change.work} size="xs" />
              <span>{change.workTitle}</span>
            </Link>
          ) : null}
          {change.db ? (
            <span className={s.db}>
              <DatabaseIcon aria-hidden />
              {change.db}
            </span>
          ) : null}
          {/* The pull request and its time stay together when the line wraps. */}
          <span className={s.prAt}>
            <PrChip pr={change.pull} url={change.pr} className={s.pr} />
            <time dateTime={at} title={exact(at)}>
              {clock(at)}
            </time>
          </span>
        </p>
      </header>
      {diff.tables.length + diff.objects.length > 0 ? (
        <div className={s.diff}>
          {blocksOf(diff).map((block) => (block.table ? <TableBlock key={`${block.table.mark} ${block.table.name}`} table={block.table} /> : <ObjectsBlock key="objects" objects={diff.objects} />))}
        </div>
      ) : (
        <p className={s.none}>No table changes found. The SQL is below.</p>
      )}
      <details className={`fold ${s.sqlFold}`} open={headline.length === 0}>
        <summary>
          <CaretRightIcon weight="bold" aria-hidden />
          <span>
            SQL <span className={s.files}>{change.files.length === 1 ? <Path path={change.files[0]!.path} /> : `${change.files.length} files`}</span>
          </span>
        </summary>
        {change.files.map((file) => (
          <figure key={file.path} className={s.file}>
            {change.files.length > 1 ? (
              <figcaption>
                <Path path={file.path} />
              </figcaption>
            ) : null}
            <pre className={s.sql}>{file.sql.trimEnd()}</pre>
          </figure>
        ))}
      </details>
    </article>
  );
}

/** The blocks of a diff in the order they are read: any that holds something dropped first, since it can't be undone. */
function blocksOf(diff: Diff): { readonly table: TableDiff | null }[] {
  const blocks = [...diff.tables.map((table) => ({ table, drops: table.mark === "dropped" || table.mark === "replaced" || table.rows.some((row) => row.mark === "dropped") })), ...(diff.objects.length ? [{ table: null, drops: diff.objects.some((object) => object.mark === "dropped") }] : [])];
  return [...blocks.filter((block) => block.drops), ...blocks.filter((block) => !block.drops)];
}

function TableBlock(props: { readonly table: TableDiff }) {
  const { table } = props;
  const mark = tableMark(table);
  // A rebuilt table's columns are its new shape, and its old one is not known: they are one line, not a diff.
  const kept = table.rows.filter((row) => row.mark === "kept");
  const rows = table.rows.filter((row) => row.mark !== "kept");
  return (
    <section className={s.block} data-mark={table.mark} data-rebuilt={table.rebuilt ? "" : undefined}>
      <h4 className={s.blockHead}>
        <TableIcon aria-hidden />
        <span className={s.blockName}>{table.name}</span>
        {table.module ? <span className={s.word}>{table.module}</span> : null}
        {mark || table.conditional ? <span className={s.blockMark}>{[mark, table.conditional ? "conditional" : null].filter(Boolean).join(" · ")}</span> : null}
      </h4>
      {kept.length ? <p className={s.kept}>{kept.map((row) => row.name).join(", ")}</p> : null}
      {rows.length ? (
        <ul className={s.rows}>
          {rows.map((row, i) => (
            <RowView key={i} row={row} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function RowView(props: { readonly row: Row }) {
  const { row } = props;
  return <DiffRow mark={row.mark} name={row.name} word={ROW_WORD[row.kind]} from={row.from} detail={row.detail} tags={row.tags} />;
}

function ObjectsBlock(props: { readonly objects: readonly ObjectDiff[] }) {
  return (
    <section className={s.block} data-mark="changed">
      <h4 className={s.blockHead}>
        <CodeIcon aria-hidden />
        <span className={s.blockTitle}>Other objects</span>
      </h4>
      <ul className={s.rows}>
        {props.objects.map((object, i) => (
          <DiffRow key={i} mark={object.mark} name={object.name} word={object.kind} detail={object.detail} tags={object.tags} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One line of a diff: its sign in the gutter, its name, then what it is in a word and its type or definition and what
 * stands beside it. A row with no name, such as a data change, is named by its kind.
 */
function DiffRow(props: { readonly mark: Mark; readonly name: string; readonly word: string; readonly from?: string | undefined; readonly detail: string; readonly tags: readonly string[] }) {
  const { sign, label } = SIGN[props.mark];
  const named = props.name !== "";
  return (
    <li className={s.row} data-mark={props.mark}>
      <span className={s.sign} role="img" aria-label={label}>
        {sign}
      </span>
      <span className={s.name}>
        {named ? (
          <>
            {props.from ? (
              <>
                <span className={s.was}>{props.from}</span>
                <span className={s.arrow}> → </span>
              </>
            ) : null}
            <span className={s.nameText}>{props.name}</span>
          </>
        ) : (
          <span className={s.word}>{props.word}</span>
        )}
      </span>
      <span className={s.said}>
        {named && props.word ? <span className={s.word}>{props.word}</span> : null}
        {props.detail ? <span className={s.detail}>{props.detail}</span> : null}
        {props.tags.length ? <span className={s.tags}>{props.tags.join(" · ")}</span> : null}
      </span>
    </li>
  );
}
