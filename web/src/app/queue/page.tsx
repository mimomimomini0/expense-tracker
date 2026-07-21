import { redirect } from "next/navigation";

/** The review queue moved into the Management tab (owner request 2026-07-21).
 *  Old links and habits keep working. */
export default function QueueRedirect() {
  redirect("/management?tab=confirm");
}
