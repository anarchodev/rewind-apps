// Terminal result of one instance's durable CP delete during account
// deletion (rove#340). Its own module because webhook.send's `on` is a
// cross-module continuation — it dispatches the TARGET MODULE's default
// export (handler-shape §2.1), unlike after.fetch's named-export resume.
// The logic lives with its siblings in index.mjs; this is the door.
import { onAcctdelCpDelete } from "./index.mjs";

export default function () {
    return onAcctdelCpDelete();
}
