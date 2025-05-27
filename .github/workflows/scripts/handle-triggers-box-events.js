const { splitWorkflows } = require("./shared/handle-split-workflow.js");
const { getEnvIdForWorkflow } = require("./helpers/getEnvIdForWorkflow.js");
const { createWorkflowRegex } = require("./helpers/createWorkflowRegex.js");

module.exports = async ({ github, context, core, eventPayload }) => {
  const {
    repo: { owner, repo },
  } = context;
  // Read BOT name from env var, fallback to default
  const actionBot = process.env.ACTION_BOT || "hani-nguyen-eh";
  const requiredWorkflowsArray = splitWorkflows({
    workflows: process.env.REQUIRED_WORKFLOWS,
  });
  const optionalWorkflowsArray = splitWorkflows({
    workflows: process.env.OPTIONAL_WORKFLOWS,
  });

  // Parse environment mappings from input
  let environmentMappings;
  try {
    environmentMappings = JSON.parse(process.env.ENVIRONMENT_MAPPINGS || "{}");
  } catch (error) {
    core.setFailed(`Failed to parse environment mappings: ${error.message}`);
    return;
  }

  // --- Basic Event Validation ---
  if (
    !eventPayload ||
    !eventPayload.issue ||
    !eventPayload.issue.pull_request
  ) {
    console.log(
      "Event payload is missing required issue or pull_request information. Skipping."
    );
    return;
  }
  if (eventPayload.comment.user.login !== actionBot) {
    console.log(
      `Comment user "${eventPayload.comment.user.login}" is not the expected bot "${actionBot}". Skipping.`
    );
    return;
  }
  if (
    !eventPayload.changes ||
    !eventPayload.changes.body ||
    !eventPayload.changes.body.from
  ) {
    console.log(
      'Event payload does not contain previous comment body ("changes.body.from"). Cannot detect changes. Skipping.'
    );
    return;
  }

  const prUrl = eventPayload.issue.pull_request.url;
  const prNumber = parseInt(prUrl.split("/").pop(), 10);
  const commentBody = eventPayload.comment.body;
  const previousBody = eventPayload.changes.body.from;

  if (isNaN(prNumber)) {
    core.setFailed(
      `Could not parse PR number from event payload URL: ${prUrl}`
    );
    return;
  }

  console.log(
    `Handling comment edit event for PR #${prNumber} by bot ${actionBot}`
  );

  // --- Get Branch Name ---
  let branchName;
  try {
    console.log("Fetching PR details to get branch name...");
    const { data: prDetails } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    branchName = prDetails.head.ref;
    console.log(`Branch name: ${branchName}`);
  } catch (error) {
    core.setFailed(
      `Failed to get PR details for PR #${prNumber}: ${error.message}`
    );
    return; // Cannot proceed without branch name
  }

  // --- Extract Commit Hash ---
  const commitHashMatch = commentBody.match(/commit ([a-f0-9]{40})/);
  const commitHash = commitHashMatch ? commitHashMatch[1] : null;
  if (commitHash) {
    console.log(`Commit hash extracted: ${commitHash}`);
  } else {
    // This might be okay if only dispatching non-approval workflows
    console.warn(
      "Could not extract commit hash from comment body. Workflow approvals will be skipped."
    );
  }

  // --- Get Environment IDs ---
  console.log("Fetching environment IDs...");
  const environmentIds = {}; // Store environment IDs by name

  try {
    const { data: environmentsResponse } =
      await github.rest.repos.getAllEnvironments({
        owner,
        repo,
      });

    if (
      environmentsResponse &&
      Array.isArray(environmentsResponse.environments)
    ) {
      // Create a map of environment names to IDs
      environmentsResponse.environments.forEach((env) => {
        environmentIds[env.name] = env.id.toString();
      });

      console.log(
        "Found environments:",
        Object.keys(environmentIds).join(", ")
      );
    } else {
      core.warning("No environments found or unexpected response structure.");
    }
  } catch (error) {
    core.warning(
      `Could not fetch environments: ${error.message}. IDs will be empty.`
    );
  }

  // Set outputs for other steps in the GitHub Action
  // Set environment IDs based on the workflow mappings
  const allWorkflows = [...requiredWorkflowsArray, ...optionalWorkflowsArray];
  allWorkflows.forEach((workflow) => {
    const envId = getEnvIdForWorkflow({
      workflow,
      environmentMappings,
      environmentIds,
    });
    if (envId) {
      core.setOutput(`${workflow}_env_id`, envId);
    }
  });

  console.log("Successfully set environment IDs as outputs.");

  // --- Analyze Checkbox Toggles ---

  // Helper to check if a specific checkbox was toggled from unchecked to checked
  function wasToggledOn(checkboxName, workflowType) {
    const uncheckedRegex = createWorkflowRegex(checkboxName, false);
    const checkedRegex = createWorkflowRegex(checkboxName, true);

    const previouslyUnchecked = uncheckedRegex.test(previousBody);
    const nowChecked = checkedRegex.test(commentBody);

    if (previouslyUnchecked && nowChecked) {
      console.log(
        `Detected toggle ON for: ${workflowType} - '${checkboxName}'`
      );
      return true;
    }
    return false;
  }

  async function processWorkflowTrigger(workflows) {
    for (const workflow of workflows) {
      if (wasToggledOn(workflow, "GA Workflow Trigger")) {
        try {
          console.log(
            `Dispatching workflow: ${workflow}.yml for branch ${branchName}`
          );
          // Dispatch the workflow regardless of environment mapping
          await github.rest.actions.createWorkflowDispatch({
            owner,
            repo,
            workflow_id: `${workflow}.yml`,
            ref: branchName,
          });
          console.log(`Successfully dispatched ${workflow}.yml`);
        } catch (error) {
          core.error(
            `Failed to dispatch workflow ${workflow}.yml: ${error.message}`
          );
        }
      }
    }
  }

  async function processWorkflowApprovals(workflows) {
    console.log("Processing workflow approvals...");
    for (const workflow of workflows) {
      if (wasToggledOn(workflow, "GA Workflow Approval")) {
        const targetEnvId = getEnvIdForWorkflow({
          workflow,
          environmentMappings,
          environmentIds,
        });

        // Only process approvals if environment mapping exists
        if (!targetEnvId) {
          console.log(
            `Skipping approval for '${workflow}' - no environment mapping found. This workflow may not require environment approval.`
          );
        }

        try {
          console.log(
            `Processing approval request for workflow '${workflow}' (Environment ID: ${targetEnvId}) for commit ${commitHash}`
          );

          // 1. Find the relevant 'waiting' workflow run
          console.log(
            `Fetching 'waiting' workflow runs named '${workflow}' with SHA ${commitHash}...`
          );
          const runsIterator = github.paginate.iterator(
            github.rest.actions.listWorkflowRunsForRepo,
            {
              owner,
              repo,
              head_sha: commitHash,
              status: "waiting", // Important: Only find runs actually waiting
              per_page: 50, // Adjust page size if needed
            }
          );

          let targetRun = null;
          for await (const { data: runs } of runsIterator) {
            // Filter for the specific workflow name IN THIS BATCH
            const matchingRunInBatch = runs.find(
              (run) => run.name === workflow
            );
            if (matchingRunInBatch) {
              // Check if this run is waiting for the specific environment
              const { data: pendingDeployments } =
                await github.rest.actions.getPendingDeploymentsForRun({
                  owner,
                  repo,
                  run_id: matchingRunInBatch.id,
                });
              const needsApprovalForEnv = pendingDeployments.some(
                (dep) =>
                  dep.environment?.id === targetEnvId &&
                  dep.waiting_for_reviewers
              );

              if (needsApprovalForEnv) {
                targetRun = matchingRunInBatch; // Found the run we need to approve
                console.log(
                  `Found target run ID: ${targetRun.id} waiting for environment ${targetEnvId}.`
                );
                break; // Stop searching pages
              } else {
                console.log(
                  `Run ID ${matchingRunInBatch.id} found, but not waiting for environment ${targetEnvId}. Checking next runs/pages.`
                );
              }
            }
          } // End run iteration

          // 2. Approve if found
          if (targetRun) {
            console.log(
              `Attempting to approve deployment for run ID ${targetRun.id} / environment ID ${targetEnvId}.`
            );
            await github.rest.actions.reviewPendingDeploymentsForRun({
              owner,
              repo,
              run_id: targetRun.id,
              environment_ids: [targetEnvId], // The specific environment we want to approve
              state: "approved",
              comment: `Approved via checkbox toggle in PR #${prNumber}.`,
            });
            console.log(
              `Successfully approved deployment for run ID ${targetRun.id} and environment ID ${targetEnvId}`
            );
          } else {
            // This is common if the run finished, was rejected, or the comment edit happened before the run reached 'waiting' state
            console.warn(
              `No 'waiting' workflow run found for '${workflow}' with SHA ${commitHash} that requires approval for environment ID ${targetEnvId}. Cannot approve.`
            );
          }
        } catch (error) {
          // Log error but don't fail the whole script
          core.error(
            `Failed to process approval for workflow '${workflow}': ${error.message}`
          );
        }
      }
    }
  }

  // --- Process Workflow Approvals ---
  if (!commitHash) {
    console.warn(
      "Skipping workflow approvals processing as commit hash was not found in the comment."
    );
  } else {
    await processWorkflowApprovals(requiredWorkflowsArray);
    await processWorkflowApprovals(optionalWorkflowsArray);
  }

  console.log("Checkbox analysis script complete.");
};
