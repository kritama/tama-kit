# Reflection comment resolution

Use this workflow when the user asks to fix or resolve graph problems reported
through Tama Reflection comments. It joins bounded MCP diagnosis, authoritative
Terraform editing, validation, and the human-review handoff.

## Preserve the authorization boundary

A request to fix or resolve an identified Reflection comment includes moving
that comment to `pending_review` after its source fix is implemented and passes
the relevant checks, unless the user limits the request to source changes, a
dry run, or approval before the transition. Merely loading, listing,
inspecting, auditing, or diagnosing comments does not authorize a state change.

`reflection.comments.review` is a mutation. Announce the intended comment
transition immediately before calling it. Never use it to claim that a fix is
deployed or accepted, and never move the comment directly to `resolved`.

Leave a comment open when:

- the evidence does not identify a source defect;
- source and runtime may be out of sync and the boundary remains unresolved;
- the fix was not implemented or its relevant validation failed;
- the comment is stale, changed, unrelated to the implemented delta, or already
  left `open`; or
- the review tool or required scope is unavailable.

Report the reason instead of treating a local edit or diagnosis as resolution.

## Load and diagnose comments

1. Call `reflection.comments.list` with `state: "open"` and the narrowest
   available `thread_id`, `step_id`, or `reference_type` filters. Use a bounded
   `limit` and follow `page.next_cursor` through `after` when the request covers
   more than one page.
2. For every selected comment, retain its `id`, `state_version`, body,
   references, and trace pointers. Do not assume multiple comments sharing a
   step have the same cause or fix.
3. Establish the repository-source baseline before interpreting runtime
   behavior. Then follow only the relevant pointers with `thread.get`,
   `thread.steps.list`, `flow.get`, `step.get`, and, when necessary,
   `artifact.get`.
4. Keep the user report, configured intent, observed execution, diagnosis, and
   deployment/runtime unknowns separate. Edit Terraform only when the combined
   evidence supports a source defect.

## Implement and hand off for review

1. Make the smallest source change that resolves the diagnosed defect. Do not
   run `terraform apply` unless separately authorized.
2. Run the repository checks and the narrowest relevant regression validation.
   A passing format or `terraform validate` check alone is not evidence that a
   runtime behavior is deployed or corrected.
3. Prepare a concise, non-blank review comment that states the implemented
   source change and the validation actually completed. Include material
   limitations such as deployment or live-runtime verification still pending.
4. Use the target comment's current `state_version` as
   `expected_state_version`. Re-list the narrowly filtered comment immediately
   before the mutation when its version may have changed.
5. Call `reflection.comments.review` once for that comment with exactly:

   - `comment_id`: the selected Reflection comment ID;
   - `expected_state_version`: the version returned by the latest list result;
   - `comment`: the bounded implementation and validation summary.

6. Verify that the response names the same comment, reports
   `state: "pending_review"`, increments `state_version`, and records a
   `review` event. Report that handoff distinctly from local validation and
   deployment status.

If the tool returns a conflict, re-list the comment instead of blindly
retrying. Retry once with the new version only when it remains open, unchanged
in meaning, and the same validated fix still applies. Otherwise stop and
report the concurrent change. In a batch, transition comments independently;
one successful fix or review must not advance another comment.
