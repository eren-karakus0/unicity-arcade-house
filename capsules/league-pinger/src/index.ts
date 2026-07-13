/**
 * league-pinger — the P1.T2 capsule-to-capsule IPC probe.
 *
 * It does exactly one thing: publish `arcade.v1.league.ping` from its
 * lifecycle hooks and daemon start. The arcade-player capsule subscribes to
 * that topic with an interceptor that logs on delivery — so the kernel log
 * answers, definitively, whether JS capsules can receive bus topics on this
 * kernel (see arcade-player/patches/UPSTREAM.md finding 3).
 */
import { capsule, install, upgrade, run, log, ipc, time, runtime } from "@unicity-astrid/sdk";

function ping(context: string): void {
  try {
    ipc.publishJson("arcade.v1.league.ping", {
      from: "league-pinger",
      context,
      at: Number(time.nowMs()),
    });
    log.info(`[pinger] published arcade.v1.league.ping (${context})`);
  } catch (e) {
    const err = e as Error & { payload?: unknown };
    let detail = "";
    try {
      detail = err.payload !== undefined ? ` payload=${JSON.stringify(err.payload)}` : "";
    } catch {
      /* unstringifiable payload */
    }
    log.warn(`[pinger] publish failed (${context}): ${err.message ?? String(e)}${detail}`);
  }
}

@capsule
export class LeaguePinger {
  @install
  onInstall(): void {
    log.info("league-pinger installed");
    ping("install");
  }

  @upgrade
  onUpgrade(): void {
    ping("upgrade");
  }

  @run
  daemon(): void {
    runtime.signalReady();
    ping("daemon");
    for (;;) time.sleepMs(1_000);
  }
}
