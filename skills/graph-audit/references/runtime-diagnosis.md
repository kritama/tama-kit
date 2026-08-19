# Runtime diagnosis

Use this workflow when the user reports a problem in a Tama thread, flow, or
step, or provides a comment that describes unexpected runtime behavior.

## Establish the static baseline first

1. Locate the target graph repository and read the owning `.tf` resources.
2. Inspect installed helper modules and locked provider versions used by those resources.
3. Trace the configured trigger, execution edges, control edges, and terminal outcomes.
4. Record stable resource names, IDs, classes, thoughts, nodes, and actions that can be correlated with runtime records.

The repository defines intended graph configuration. Never substitute a graph
or configuration projection returned by MCP for this inspection.

## Inspect bounded runtime evidence

Use the configured Tama MCP only for the smallest runtime slice needed to test
the user's report:

1. Read the identified thread and confirm it belongs to the expected scope.
2. Enumerate its steps with pagination rather than requesting an unbounded conversation projection.
3. Follow only the flow and step references relevant to the reported symptom.
4. Fetch large artifacts through their references only when their content is necessary.
5. Preserve timestamps, statuses, inputs, outputs, errors, and referenced IDs that support or contradict the report.

If the user did not provide enough identifying information and it cannot be
resolved safely from the available context, state what thread, flow, or step ID
is needed. Do not broaden the inspection across unrelated tenant or space data.

## Correlate, then diagnose

Map runtime records back to repository resources using stable identifiers and
declared names where possible. Present the result in this order:

1. **User report:** the symptom being investigated.
2. **Configured intent:** the relevant source-derived path.
3. **Observed execution:** the bounded thread, flow, step, and artifact evidence.
4. **Diagnosis:** the smallest explanation supported by both evidence sets.
5. **Unknowns:** facts that require logs, worker state, credentials, provider responses, Terraform state, or deployment records.

If the source path and deployed behavior do not match, classify the result as
possible deployment or source drift. Do not “correct” the source-derived trace
using runtime graph metadata. Do not recommend a Terraform edit until the
evidence identifies a source defect rather than stale deployment, runtime
failure, bad input, or external-system behavior.
