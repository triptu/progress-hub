import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRightIcon, ArrowSquareOutIcon, BrowserIcon, CaretLeftIcon, CaretRightIcon, FileTextIcon, FilmStripIcon, ImageIcon, PlayIcon, RowsIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { WorkId } from "../../core/types.ts";
import type { MediaDay, MediaItem, MediaKind } from "../lib/media.ts";
import { fileName, pictureSrc } from "../lib/media.ts";
import { followLink, routeHref, useRoute } from "../lib/route.ts";
import { usePersisted } from "../lib/persist.ts";
import { Ago, Link, ListHead } from "./parts.tsx";
import s from "./Media.module.css";

interface MediaProps {
  /** Null while the list loads. */
  readonly days: readonly MediaDay[] | null;
  /** The kinds this screen's media come in, and the ones the list is narrowed to. */
  readonly kinds: readonly MediaKind[];
  readonly chosen: ReadonlySet<MediaKind>;
  readonly onChosen: (chosen: ReadonlySet<MediaKind>) => void;
  readonly query: string;
  /** The open work, whose media these are, or null on Home. */
  readonly scope: WorkId | null;
  /** On Home, what the list covers. */
  readonly sub?: string;
  /** What sits above the grid on a work: the work's head and goal. */
  readonly children?: ReactNode;
}

const readRows = (stored: unknown) => stored === true;

/** How each kind is named and drawn, on its filter and beside an artifact. */
const KIND: Record<MediaKind, { readonly Icon: Icon; readonly label: string }> = {
  image: { Icon: ImageIcon, label: "Images" },
  video: { Icon: FilmStripIcon, label: "Videos" },
  page: { Icon: BrowserIcon, label: "Pages" },
  file: { Icon: FileTextIcon, label: "Documents" },
};

export function Media(props: MediaProps) {
  const { days, chosen } = props;
  const toggle = (kind: MediaKind) => props.onChosen(new Set(chosen.has(kind) ? [...chosen].filter((k) => k !== kind) : [...chosen, kind]));
  // A grid to scan many at once, or one to a row to look at each. The choice is kept.
  const [rows, setRows] = usePersisted("progress:media-rows", readRows);
  // About what a screen opens on. The rest load as they come near.
  const first = new Set((days ?? []).flatMap((day) => day.items).slice(0, 12).map((item) => item.src));
  return (
    <div className="wrap media">
      {props.children}
      <ListHead title="Media" sub={props.sub} scoped={props.scope !== null}>
        {/* A kind is offered only while there is another to narrow away from. */}
        {props.kinds.length > 1
          ? props.kinds.map((kind) => {
              const { Icon, label } = KIND[kind];
              const on = chosen.has(kind);
              return (
                <button key={kind} type="button" className="icon-btn tool" aria-pressed={on} aria-label={label} title={on ? `Showing ${label.toLowerCase()}. Click to stop narrowing to them.` : props.kinds.some((k) => chosen.has(k)) ? `Show ${label.toLowerCase()} too` : `Show only ${label.toLowerCase()}`} onClick={() => toggle(kind)}>
                  <Icon aria-hidden />
                </button>
              );
            })
          : null}
        <button type="button" className={`icon-btn tool ${s.layout}`} aria-pressed={!rows} aria-label="Gallery" title="Show as a gallery" onClick={() => setRows(false)}>
          <SquaresFourIcon aria-hidden />
        </button>
        <button type="button" className="icon-btn tool" aria-pressed={rows} aria-label="One to a row" title="Show one to a row" onClick={() => setRows(true)}>
          <RowsIcon aria-hidden />
        </button>
      </ListHead>
      {days?.map((day) => (
        <section key={day.key} className="day">
          <h2 className="day-head">{day.label}</h2>
          <div className={`tiles${rows ? " rows" : ""}`}>
            {day.items.map((item) => (
              <Tile key={item.src} item={item} scope={props.scope} eager={first.has(item.src)} />
            ))}
          </div>
        </section>
      ))}
      {days && !days.length ? (
        <p className="nothing">{props.query ? `Nothing matches “${props.query}”.` : props.scope ? "This work's page shows no images, videos, pages or documents." : "Once a work's page shows images, videos, pages or documents, they appear here."}</p>
      ) : null}
    </div>
  );
}

/** Where one of the media opens: large over the tab it is on, or for a document, in a tab of its own. */
function useOpen(scope: WorkId | null) {
  const { tab } = useRoute();
  return (item: MediaItem) => (item.kind === "file" ? { href: item.src, target: "_blank", rel: "noopener noreferrer" } : { href: routeHref({ work: scope, tab, open: item.src }), onClick: followLink });
}

/**
 * What a work made that is more than a screenshot: pages, documents and recordings its page links or shows.
 * They sit in one place beside the page, so none is lost in the text.
 */
export function Artifacts(props: { readonly items: readonly MediaItem[]; readonly scope: WorkId }) {
  const open = useOpen(props.scope);
  const made = props.items.filter((item) => item.kind !== "image");
  if (made.length === 0) return null;
  return (
    <nav aria-label="Artifacts">
      <p className="outline-title">Artifacts</p>
      <ul>
        {made.map((item) => {
          const { Icon } = KIND[item.kind];
          return (
            <li key={item.src}>
              <a className={s.artifact} title={`${item.label} (${fileName(item.src)})`} {...open(item)}>
                <Icon aria-hidden />
                <span>{item.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** One of the media as a tile: a picture, a video's first frame, a page as it looks, or a document's name. */
/** `eager` is for the tiles a screen opens on: their pictures are in the first frame instead of arriving after it. */
export function Tile(props: { readonly item: MediaItem; readonly scope: WorkId | null; readonly eager?: boolean }) {
  const { item } = props;
  const open = useOpen(props.scope);
  return (
    <a className={s.tile} title={item.label} {...open(item)}>
      <span className={s.tileFrame} data-kind={item.kind}>
        {item.kind === "image" ? <img src={pictureSrc(item)} alt="" loading={props.eager ? "eager" : "lazy"} /> : null}
        {item.kind === "video" ? (
          <>
            <video src={`${item.src}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} />
            <span className={s.tilePlay} aria-label="Video">
              <PlayIcon weight="fill" aria-hidden />
            </span>
          </>
        ) : null}
        {item.kind === "page" ? (
          // The page itself, as a picture of it: it can't be clicked or scrolled here, and a click on the tile opens it.
          // It shows once it has loaded: until then the frame is the tile's own ground, not a white flash.
          <iframe src={item.src} sandbox="allow-scripts" loading="lazy" tabIndex={-1} aria-hidden title="" onLoad={(event) => event.currentTarget.classList.add(s.in)} />
        ) : null}
        {item.kind === "file" ? (
          <span className={s.tilePage}>
            <FileTextIcon aria-hidden />
            <span>{fileName(item.src)}</span>
            {/* The one kind that leaves the hub: it opens in a tab of its own. */}
            <ArrowSquareOutIcon className={s.tileOut} role="img" aria-label="Opens in a new tab" />
          </span>
        ) : null}
      </span>
      <span className={s.tileText}>
        <span className={s.tileCap}>{item.label}</span>
        {props.scope ? null : <span className={s.tileWork}>{item.workTitle}</span>}
      </span>
    </a>
  );
}

/** One of the media shown large, over the screen it was opened from. `at` of `of` is its place in that screen's list. */
export function Viewer(props: { readonly item: MediaItem; readonly prev: MediaItem | null; readonly next: MediaItem | null; readonly at: number; readonly of: number; readonly onMove: (item: MediaItem) => void; readonly onClose: () => void; readonly now: number }) {
  const { item, prev, next, onMove, onClose } = props;
  // The viewer is the only thing to use while it is open: the app behind it is out of reach, and whatever opened it has focus again after.
  // Read while rendering: by the time an effect runs, the viewer's own Close button has focus.
  const opener = useRef(document.activeElement);
  const self = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Everything else on the page, a card open on the board included. What was already out of reach stays so after.
    const under = [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== self.current && !el.inert);
    for (const el of under) el.inert = true;
    return () => {
      for (const el of under) el.inert = false;
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft" && prev && !isTyping(event)) onMove(prev);
      else if (event.key === "ArrowRight" && next && !isTyping(event)) onMove(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onMove, onClose]);

  return createPortal(
    <div ref={self} className={s.viewer} role="dialog" aria-modal="true" aria-label={item.label}>
      <header className={s.viewerHead}>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" autoFocus>
          <XIcon aria-hidden />
        </button>
        <div className={s.viewerText}>
          <p className={s.viewerCap} title={item.label}>
            {item.label}
          </p>
          <p className={s.viewerMeta}>
            {/* First, so a narrow screen cuts the work's name short and not the place. */}
            {props.of > 1 ? `${props.at} of ${props.of} · ` : null}
            {item.workTitle} · <Ago verb="saved" at={item.at} now={props.now} />
          </p>
        </div>
        <Link href={routeHref({ work: item.work, focus: item.src })} className="btn" aria-label="Show on page" title="Show on page">
          <span className={s.viewerWhere}>Show on page</span>
          <ArrowRightIcon aria-hidden />
        </Link>
      </header>
      <div className={s.viewerStage}>
        {item.kind === "image" ? (
          <Picture key={item.src} item={item} onClose={onClose} />
        ) : (
          <div className={s.viewerFit} onClick={(event) => (event.target === event.currentTarget ? onClose() : undefined)}>
            {item.kind === "video" ? <video key={item.src} src={item.src} controls autoPlay playsInline /> : null}
            {item.kind === "page" ? <iframe key={item.src} src={item.src} sandbox="allow-scripts" title={item.label} /> : null}
          </div>
        )}
        {/* An end of the list has no arrow, where a faded one would look like it might work. */}
        {prev ? (
          <button type="button" className={`icon-btn ${s.viewerPrev}`} onClick={() => onMove(prev)} aria-label="Newer" title="Newer">
            <CaretLeftIcon weight="bold" aria-hidden />
          </button>
        ) : null}
        {next ? (
          <button type="button" className={`icon-btn ${s.viewerNext}`} onClick={() => onMove(next)} aria-label="Older" title="Older">
            <CaretRightIcon weight="bold" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A picture, fitted to the stage. With a mouse, a click shows it at its full size around the point clicked,
 * to be dragged or scrolled, and another click fits it again. A touch screen has its own pinch for that.
 * Escape, or a click beside the picture, steps out: from full size to fitted, and from fitted out of the viewer.
 */
function Picture(props: { readonly item: MediaItem; readonly onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  /** Where the click was: the point of the picture, as a share of its size, and the place on screen it must stay at. */
  const [zoom, setZoom] = useState<{ readonly fx: number; readonly fy: number; readonly x: number; readonly y: number } | null>(null);
  /** Whether the fitted picture is smaller than the file, so there is more to see. */
  const [more, setMore] = useState(false);
  const pointer = useRef({ touch: false, drag: null as { readonly x: number; readonly y: number; readonly left: number; readonly top: number } | null, dragged: false });

  useEffect(() => {
    if (zoom) return;
    const measure = () => setMore(image.current !== null && image.current.naturalWidth > image.current.clientWidth * 1.15);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [zoom]);

  useEffect(() => {
    if (!zoom) return;
    // Heard before the viewer's own Escape, which would close it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setZoom(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [zoom]);

  useLayoutEffect(() => {
    if (!zoom || !box.current || !image.current) return;
    const at = image.current.getBoundingClientRect();
    box.current.scrollLeft += at.left + zoom.fx * at.width - zoom.x;
    box.current.scrollTop += at.top + zoom.fy * at.height - zoom.y;
  }, [zoom]);

  return (
    <div ref={box} className={`${s.viewerFit}${zoom ? ` ${s.zoomed}` : more ? ` ${s.zooms}` : ""}`} onClick={(event) => (event.target !== event.currentTarget ? undefined : zoom ? setZoom(null) : props.onClose())}>
      <img
        ref={image}
        src={pictureSrc(props.item)}
        alt={props.item.caption}
        draggable={false}
        onLoad={(event) => setMore(event.currentTarget.naturalWidth > event.currentTarget.clientWidth * 1.15)}
        onPointerDown={(event) => {
          pointer.current = { touch: event.pointerType === "touch", drag: null, dragged: false };
          if (!zoom || event.pointerType !== "mouse" || event.button !== 0 || !box.current) return;
          pointer.current.drag = { x: event.clientX, y: event.clientY, left: box.current.scrollLeft, top: box.current.scrollTop };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const { drag } = pointer.current;
          if (!drag || !box.current) return;
          const [dx, dy] = [event.clientX - drag.x, event.clientY - drag.y];
          // A press that barely moves is a click, not a drag.
          if (Math.abs(dx) + Math.abs(dy) > 4) pointer.current.dragged = true;
          box.current.scrollTo(drag.left - dx, drag.top - dy);
        }}
        onPointerUp={() => {
          pointer.current.drag = null;
        }}
        onClick={(event) => {
          if (pointer.current.touch || pointer.current.dragged) return;
          if (zoom) return setZoom(null);
          if (!more) return;
          const at = event.currentTarget.getBoundingClientRect();
          setZoom({ fx: (event.clientX - at.left) / at.width, fy: (event.clientY - at.top) / at.height, x: event.clientX, y: event.clientY });
        }}
      />
    </div>
  );
}

function isTyping(event: KeyboardEvent): boolean {
  return event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLMediaElement;
}
