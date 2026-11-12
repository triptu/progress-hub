import {
  AnchorIcon,
  BirdIcon,
  CompassIcon,
  CubeIcon,
  FeatherIcon,
  FlaskIcon,
  GavelIcon,
  LeafIcon,
  LighthouseIcon,
  MountainsIcon,
  PaintBrushIcon,
  PlanetIcon,
  PuzzlePieceIcon,
  SailboatIcon,
  StackIcon,
  ToolboxIcon,
  VideoCameraIcon,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

const ICONS: readonly Icon[] = [
  BirdIcon,
  VideoCameraIcon,
  StackIcon,
  ToolboxIcon,
  GavelIcon,
  LeafIcon,
  SailboatIcon,
  PlanetIcon,
  FeatherIcon,
  CompassIcon,
  LighthouseIcon,
  PuzzlePieceIcon,
  FlaskIcon,
  MountainsIcon,
  PaintBrushIcon,
  CubeIcon,
  AnchorIcon,
];

/** How many project colours tokens.css defines, as --p0 and up. */
const COLOURS = 6;

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** How a project is drawn wherever its work shows: an icon on a tile of its colour. */
interface ProjectLook {
  readonly Icon: Icon;
  /** The CSS variable that holds the colour. */
  readonly colour: string;
}

const look = (icon: number, colour: number): ProjectLook => ({ Icon: ICONS[icon % ICONS.length] ?? BirdIcon, colour: `var(--p${colour % COLOURS})` });

/** Every work of one project shares a look, picked from the project's name. */
export function projectLook(key: string): ProjectLook {
  const h = hash(key.toLowerCase());
  return look(h, Math.floor(h / ICONS.length));
}

/** The icon and colour each project was given, by its name in lower case. The browser keeps it. */
type KeptLooks = Readonly<Record<string, readonly [icon: number, colour: number]>>;

/** What was stored, as looks: anything this code didn't write is left out. */
export function readKeptLooks(stored: unknown): KeptLooks {
  if (typeof stored !== "object" || stored === null) return {};
  const isLook = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every((n) => Number.isInteger(n) && n >= 0);
  return Object.fromEntries(Object.entries(stored).filter(([, value]) => isLook(value)));
}

/**
 * Gives each project on screen a look and returns what to keep. A project keeps the look it was first given,
 * so a new project, or another machine's work showing up, never changes how an older one is drawn. A new
 * project takes the icon its name hashes to, or the next free one, and the colour the fewest projects on screen have.
 */
export function keepLooks(keys: Iterable<string>, kept: KeptLooks): KeptLooks {
  const names = [...new Set([...keys].map((key) => key.toLowerCase()))].sort();
  const fresh = names.filter((name) => !Object.hasOwn(kept, name));
  if (fresh.length === 0) return kept;
  const next: Record<string, readonly [number, number]> = { ...kept };
  const icons = new Set(Object.values(kept).map(([icon]) => icon % ICONS.length));
  const colours = Array.from({ length: COLOURS }, () => 0);
  for (const name of names) {
    const colour = kept[name]?.[1];
    if (colour !== undefined) colours[colour % COLOURS]! += 1;
  }
  for (const name of fresh) {
    if (icons.size === ICONS.length) icons.clear();
    let icon = hash(name) % ICONS.length;
    while (icons.has(icon)) icon = (icon + 1) % ICONS.length;
    icons.add(icon);
    const colour = colours.indexOf(Math.min(...colours));
    colours[colour]! += 1;
    next[name] = [icon, colour];
  }
  return next;
}

/** The look of each project that has one kept. A name without one takes the look its hash picks. */
export function projectLooks(kept: KeptLooks): (key: string) => ProjectLook {
  return (key) => {
    const name = key.toLowerCase();
    const mine = Object.hasOwn(kept, name) ? kept[name] : undefined;
    return mine ? look(mine[0], mine[1]) : projectLook(key);
  };
}
