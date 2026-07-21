# Known issues

## research-synthesis workflow recovery wedges after SIGKILL

The `research-synthesis pins its definition and survives SIGKILL without duplicate effects`
scenario in `packages/runtime/test/workflow.test.ts` is skipped. On slower machines (reproduced
consistently on 4-vCPU CI runners, never on a fast local machine), killing the host mid-fan-out
and recovering leaves the run in `running` forever: the oracle member is dispatched a second time
after recovery, and the run never reaches `completed` even after every dispatched child is
released. Budgets up to 180 seconds do not help, so this looks like a genuine recovery defect in
the workflow fan-out replay path (or in @relayfx/sdk 0.4.2's workflow recovery), exposed when the
SIGKILL lands in a specific persistence window. Re-enable the scenario once recovery is fixed.
