import { BrowserIcon, CloudArrowUpIcon, FolderSimpleIcon, LaptopIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Health } from "../../core/types.ts";
import { CHECK_SAYS, MACHINE_SAYS, statusOf } from "../lib/devices.ts";
import type { Check, Devices as Listed, Machine, Status } from "../lib/devices.ts";
import { clock, exact, isToday } from "../lib/time.ts";
import { Ago } from "./parts.tsx";
import s from "./Devices.module.css";

const ICON: Record<Check["kind"], Icon> = { browser: BrowserIcon, pages: FolderSimpleIcon, source: RobotIcon, central: CloudArrowUpIcon };
const says = (check: Check) => CHECK_SAYS[check.kind][check.ok ? "ok" : "fault"];

const works = (n: number) => (n === 1 ? "1 work" : `${n} works`);

/**
 * Every machine the hub shows work from and whether it answers, then what the hub itself reads and sends to.
 * This is the one place that says something can't be reached. The bar's button says so in a dot, and opens it.
 * It is about the whole hub, so it is a dialog over whatever is on screen, and not a screen among the work's.
 */
export function Devices(props: { readonly devices: Listed; readonly loaded: boolean; readonly now: number; readonly onClose: () => void }) {
  const { machines, checks, trouble } = props.devices;
  // Shown as the browser's own modal: it holds the keys and the focus, Escape closes it, and focus goes back to the button.
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);
  // A press outside closes it. One that starts inside and ends outside, as selecting its text can, does not.
  const pressedOutside = useRef(false);
  return (
    <dialog
      ref={dialog}
      className={s.dialog}
      aria-labelledby="devices-title"
      onClose={props.onClose}
      onPointerDown={(event) => void (pressedOutside.current = event.target === event.currentTarget)}
      onClick={(event) => (pressedOutside.current && event.target === event.currentTarget ? event.currentTarget.close() : undefined)}
    >
      <header className={s.head}>
        <div className={s.headText}>
          <h2 id="devices-title">Devices</h2>
          <p className={s.said}>{trouble || (props.loaded ? "Everything is connected." : null)}</p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={() => dialog.current?.close()}>
          <XIcon aria-hidden />
        </button>
      </header>
      <div className={s.body}>
        <section className={s.group} aria-labelledby="devices-machines">
          <h3 className={s.label} id="devices-machines">
            Machines
          </h3>
          {machines.length > 0 ? (
            <ul>
              {machines.map((machine) => (
                <MachineRow key={machine.id ?? ""} machine={machine} now={props.now} />
              ))}
            </ul>
          ) : props.loaded ? (
            <p className={s.none}>No machine has sent its work here yet.</p>
          ) : null}
        </section>
        <section className={s.group} aria-labelledby="devices-hub">
          <h3 className={s.label} id="devices-hub">
            This hub
          </h3>
          <ul>
            {checks.map((check) => (
              <Row key={check.key} icon={ICON[check.kind]} status={check.ok ? "ok" : "fault"} says={says(check)}>
                <p className={s.name}>{check.name}</p>
                {check.about ? <p className={s.sub}>{check.about}</p> : null}
                {check.broken ? <Reason broken={check.broken} now={props.now} /> : null}
              </Row>
            ))}
          </ul>
        </section>
      </div>
    </dialog>
  );
}

function MachineRow(props: { readonly machine: Machine; readonly now: number }) {
  const { machine } = props;
  const status = statusOf(machine);
  return (
    <Row icon={LaptopIcon} status={status} says={MACHINE_SAYS[status]} title={machine.health.ok ? "" : machine.health.reason}>
      <p className={s.name}>
        {machine.name}
        {machine.twin && machine.id ? <code className={s.id}>{machine.id}</code> : null}
        {machine.id === null ? <span className={s.tag}>runs this hub</span> : null}
      </p>
      <p className={s.sub}>
        {works(machine.works)}
        {!machine.health.ok ? <Ago verb=" · last heard" at={machine.health.since} now={props.now} /> : machine.lastChangeAt ? <Ago verb=" · changed" at={machine.lastChangeAt} now={props.now} /> : null}
      </p>
      {status === "fault" && machine.unread ? <Reason what={machine.unread.name} broken={machine.unread.broken} now={props.now} /> : null}
    </Row>
  );
}

/** Since when something has been at fault, and what the hub was told. */
function Reason(props: { readonly what?: string; readonly broken: Extract<Health, { ok: false }>; readonly now: number }) {
  const { since, reason } = props.broken;
  return (
    <p className={s.sub}>
      {props.what ? `${props.what} can't be read since ` : "Since "}
      <time dateTime={since} title={exact(since)}>
        {isToday(since, props.now) ? clock(since) : exact(since)}
      </time>
      . {reason}
    </p>
  );
}

/** One line of either list: what it is, what is known of it, and its state in a dot and a word at the row's end. */
function Row(props: { readonly icon: Icon; readonly status: Status; readonly says: string; readonly title?: string; readonly children: ReactNode }) {
  return (
    <li className={s.row} title={props.title || undefined}>
      <span className="avatar quiet" aria-hidden>
        <props.icon />
      </span>
      <div className={s.text}>{props.children}</div>
      <p className={s.status} data-status={props.status}>
        <span className={s.dot} aria-hidden />
        {props.says}
      </p>
    </li>
  );
}
