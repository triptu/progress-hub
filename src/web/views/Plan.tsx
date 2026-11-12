import type { ReactNode } from "react";
import type { PlanEntry } from "../../core/types.ts";
import { routeHref } from "../lib/route.ts";
import type { Tab } from "../lib/route.ts";
import { Entry } from "./Entry.tsx";
import { ListHead } from "./parts.tsx";

interface PlanProps {
  /** What is in progress, or what is planned next, in the order the pages list it. */
  readonly entries: readonly PlanEntry[];
  /** Every line is from the open work, so none says which work it is from. */
  readonly scoped: boolean;
  readonly tab: Tab;
  readonly empty: string;
  /** What opens the column: a work's goal. */
  readonly lead?: ReactNode;
  /** What the list is called: the tab's name. On Home `sub` says what it covers. */
  readonly title: string;
  readonly sub?: string;
  /** What sits above the list on a work: the work's head. */
  readonly children?: ReactNode;
  readonly now: number;
}

/**
 * What a work has in progress, or has planned next, as its page lists it. Drawn with the rows the Shipped
 * list uses, so the three states of a piece of work read the same way. On Home each row says which work it is from.
 */
export function Plan(props: PlanProps) {
  return (
    <div className="wrap">
      {props.children}
      <div className="feed-grid">
        <div className="feed-main">
          {props.lead}
          <ListHead title={props.title} sub={props.sub} scoped={props.scoped} />
          {props.entries.length ? (
            <ul className="timeline">
              {props.entries.map((entry) => {
                const from = props.scoped ? undefined : { title: entry.workTitle, project: entry.project ?? entry.work, href: routeHref({ work: entry.work, tab: props.tab }) };
                // A pull request still open that no line names: its title stands in for the line.
                if (entry.item === null) return <Entry key={entry.pr.url} kind={entry.state} weight="normal" text={entry.pr.title || `#${entry.pr.number}`} prs={[entry.pr]} from={from} at={entry.pr.openedAt} now={props.now} />;
                const { item } = entry;
                return <Entry key={`${entry.work}/${item.id}`} kind={entry.state} weight={item.important ? "high" : "normal"} html={item.titleHtml} body={item.html} prs={item.prs} commits={item.commits} important={item.important} from={from} at={item.since} now={props.now} />;
              })}
            </ul>
          ) : (
            <p className="nothing">{props.empty}</p>
          )}
        </div>
      </div>
    </div>
  );
}
