---
title: Assistant tool-call failures
project: kestrel
---

Failed tool calls are down to 2.96% a day, from 3.64%. The Slack refusal rule went too far and is corrected.

## Goal

Fewer of the assistant's tool calls fail. Each fix ships with a count of when it fired and whether the next call then worked.

## Needs you

Nothing right now.

## In progress

- https://github.com/kestrel-labs/kestrel/pull/2429 Retry a calendar call once when the provider times out.
  Waiting on a full day of traces before and after.

## Next

- Group the remaining failures by integration and take the largest next.

## Decisions

- The daily number counts full UTC days only. A part of a day is shown on its own, never as the next point.

## Shipped

- https://github.com/kestrel-labs/kestrel/pull/2426 Slack refusals only fire on the one unsafe action.

  Live: on the assistant service.
- https://github.com/kestrel-labs/kestrel/pull/2423 Slack asks before it posts to a channel it has not posted to.

  Live: on the assistant service.
- ! https://github.com/kestrel-labs/kestrel/pull/2420 Linear calls send the team's own labels.

  Live: on the assistant service.
- https://github.com/kestrel-labs/kestrel/pull/2416 Calendar arguments are checked before the call.

  Live: on the assistant service.
