import { useState } from "react";
import { CheckIcon, CopyIcon, PlantIcon } from "@phosphor-icons/react";
import s from "./Empty.module.css";

const COMMAND = 'progress new "<title>"';

/** No work has a page yet: the one command that starts one. */
export function Empty() {
  const [copied, setCopied] = useState(false);
  return (
    <div className={s.empty}>
      <PlantIcon weight="duotone" className={s.emptyIcon} aria-hidden />
      <h1>No work yet</h1>
      <p>Have an agent run this in its thread, and its page shows up here.</p>
      <div className={`cmd ${s.cmdCopy}`}>
        <code>{COMMAND}</code>
        <button
          type="button"
          className="icon-btn"
          aria-label={copied ? "Copied" : "Copy command"}
          title={copied ? "Copied" : "Copy"}
          onClick={() => {
            void navigator.clipboard.writeText(COMMAND).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        </button>
      </div>
    </div>
  );
}
