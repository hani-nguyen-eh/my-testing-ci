const {
  getEnvIdForWorkflow,
  waitForWorkflowRunToBeReady,
  wasToggledOn,
  fetchEnvironmentIds,
} = require("./helpers.js");

module.exports = async ({ github, context, core, eventPayload }) => {
  const {
    repo: { owner, repo },
  } = context;
  const actionBot = process.env.ACTION_BOT || "hani-nguyen-eh";

  const parseWorkflowDispatchConfig = () => {
    try {
      return JSON.parse(process.env.WORKFLOW_DISPATCH_CONFIG_JSON || "{}");
    } catch (error) {
      core.setFailed(
        `Failed to parse workflow dispatch config: ${error.message}`
      );
      throw error;
    }
  };

  const workflowDispatchConfig = parseWorkflowDispatchConfig();

  const allWorkflows = Object.keys(workflowDispatchConfig);

  console.log(
    "Validating workflows defined in workflow-dispatch-config-json..."
  );
  const validationErrors = [];

  for (const workflow of allWorkflows) {
    try {
      const { data: workflowInfo } = await github.rest.actions.getWorkflow({
        owner,
        repo,
        workflow_id: `${workflow}.yml`,
      });

      console.log(`✅ Workflow ${workflow}.yml exists and is accessible`);

      if (workflowInfo.html_url) {
        console.log(
          `✅ Workflow ${workflow}.yml appears to be properly configured`
        );
      }
    } catch (error) {
      const errorMsg = `❌ Workflow ${workflow}.yml validation failed: ${error.message}`;
      console.error(errorMsg);
      validationErrors.push(errorMsg);
    }
  }

  if (validationErrors.length > 0) {
    const errorSummary = `Workflow validation failed for ${
      validationErrors.length
    } workflow(s):\n${validationErrors.join("\n")}`;
    core.setFailed(errorSummary);
    process.exit(1);
  }

  console.log(
    `✅ All ${allWorkflows.length} workflows in workflow-dispatch-config-json are valid`
  );

  // --- Basic Event Validation ---
  if (
    !eventPayload ||
    !eventPayload.issue ||
    !eventPayload.issue.pull_request
  ) {
    console.log(
      "Event payload is missing required issue or pull_request information. Skipping."
    );
    process.exit(1);
  }
  if (eventPayload.comment.user.login !== actionBot) {
    console.log(
      `Comment user "${eventPayload.comment.user.login}" is not the expected bot "${actionBot}". Skipping.`
    );
    process.exit(1);
  }
  if (
    !eventPayload.changes ||
    !eventPayload.changes.body ||
    !eventPayload.changes.body.from
  ) {
    console.log(
      'Event payload does not contain previous comment body ("changes.body.from"). Cannot detect changes. Skipping.'
    );
    process.exit(1);
  }

  const prUrl = eventPayload.issue.pull_request.url;
  const prNumber = parseInt(prUrl.split("/").pop(), 10);
  const commentBody = eventPayload.comment.body;
  const previousBody = eventPayload.changes.body.from;

  if (isNaN(prNumber)) {
    core.setFailed(
      `Could not parse PR number from event payload URL: ${prUrl}`
    );
    process.exit(1);
  }

  console.log(
    `Handling comment edit event for PR #${prNumber} by bot ${actionBot}`
  );

  // --- Get Branch Name ---
  const fetchBranchName = async () => {
    try {
      console.log("Fetching PR details to get branch name...");
      const { data: prDetails } = await github.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      console.log(`Branch name: ${prDetails.head.ref}`);
      return prDetails.head.ref;
    } catch (error) {
      core.setFailed(
        `Failed to get PR details for PR #${prNumber}: ${error.message}`
      );
      throw error;
    }
  };

  const branchName = await fetchBranchName();

  // --- Extract Commit Hash ---
  const commitHashMatch = commentBody.match(/commit ([a-f0-9]{40})/);
  const commitHash = commitHashMatch ? commitHashMatch[1] : null;
  if (commitHash) {
    console.log(`Commit hash extracted: ${commitHash}`);
  } else {
    console.warn(
      "Could not extract commit hash from comment body. Workflow approvals will be skipped."
    );
  }

  // --- Analyze Checkbox Toggles ---

  async function processWorkflowApprovals(workflows) {
    console.log("Processing workflow approvals...");

    // Only fetch environment IDs if there are workflows that need approval
    let environmentIds = {};
    // reduce API calls by fetching environment IDs only once if there are multiple workflows that need approval at the same time
    let environmentIdsFetched = false;

    for (const workflow of workflows) {
      if (
        wasToggledOn(
          workflow,
          "GA Workflow Approval",
          commentBody,
          previousBody
        )
      ) {
        // First check if this workflow needs environment approval
        const envName = workflowDispatchConfig[workflow];

        if (!envName) {
          console.log(
            `No environment mapping found for '${workflow}' - triggering workflow dispatch immediately as it doesn't require environment approval.`
          );

          // Trigger workflow dispatch immediately for workflows without environment approval
          try {
            await github.rest.actions.createWorkflowDispatch({
              owner,
              repo,
              workflow_id: `${workflow}.yml`,
              ref: branchName,
            });
            console.log(
              `Successfully triggered workflow dispatch for '${workflow}' without environment approval.`
            );
          } catch (error) {
            core.setFailed(
              `Failed to trigger workflow dispatch for '${workflow}': ${error.message}`
            );
          }
          continue; // Skip to next workflow
        }

        // Fetch environment IDs only when we have workflows that need approval
        if (!environmentIdsFetched) {
          environmentIds = await fetchEnvironmentIds(github, owner, repo, core);
          environmentIdsFetched = true;
        }

        const targetEnvId = getEnvIdForWorkflow({
          workflow,
          workflowDispatchConfig,
          environmentIds,
        });

        if (!targetEnvId) {
          const errorMsg = `Configuration error: Environment '${envName}' is mapped for workflow '${workflow}' but does not exist in the repository. Please check your workflow dispatch configuration and repository environment settings.`;
          console.error(errorMsg);
          core.setFailed(errorMsg);
          throw new Error(errorMsg);
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
              per_page: 50,
            }
          );

          let targetRun = null;
          for await (const { data: runs } of runsIterator) {
            const matchingRunInBatch = runs.find(
              (run) => run.path === `.github/workflows/${workflow}.yml`
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
                (dep) => dep.environment?.id === targetEnvId
              );
              if (needsApprovalForEnv) {
                targetRun = matchingRunInBatch;
                console.log(
                  `Found target run ID: ${targetRun.id} waiting for environment ${targetEnvId}.`
                );
                break;
              } else {
                console.log(
                  `Run ID ${matchingRunInBatch.id} found, but not waiting for environment ${targetEnvId}. Checking next runs/pages.`
                );
              }
            }
          }

          // 2. Approve if found with retry logic in finding the waiting workflow run
          if (targetRun) {
            const approveDeployment = async () => {
              try {
                await github.rest.actions.reviewPendingDeploymentsForRun({
                  owner,
                  repo,
                  run_id: targetRun.id,
                  environment_ids: [targetEnvId],
                  state: "approved",
                  comment: `Approved via checkbox toggle in PR #${prNumber}.`,
                });
                console.log(
                  `Successfully approved deployment for run ID ${targetRun.id} and environment ID ${targetEnvId}`
                );
              } catch (error) {
                core.setFailed(
                  `Failed to approve deployment for run ID ${targetRun.id}: ${error.message}`
                );
                throw error;
              }
            };

            if (targetRun.status === "waiting") {
              await approveDeployment();
            } else {
              const TIMEOUT = 15000;
              const RETRY_DELAY = 3000;
              console.log(
                `Attempting to approve deployment for run ID ${targetRun.id} / environment ID ${targetEnvId}`
              );

              const isWorkflowRunReady = await waitForWorkflowRunToBeReady({
                core,
                github,
                owner,
                repo,
                runId: targetRun.id,
                timeout: TIMEOUT,
                retryDelay: RETRY_DELAY,
              });

              if (!isWorkflowRunReady) {
                return;
              }

              try {
                const { data: pendingDeployments } =
                  await github.rest.actions.getPendingDeploymentsForRun({
                    owner,
                    repo,
                    run_id: targetRun.id,
                  });

                if (pendingDeployments.length === 0) {
                  console.log(
                    `No pending deployments found for run ID ${targetRun.id}. It might have been approved or cancelled.`
                  );
                  return;
                }

                console.log(
                  `Pending deployments for run ID ${
                    targetRun.id
                  }: ${JSON.stringify(pendingDeployments)}`
                );

                const envToApprove = pendingDeployments.find(
                  (deployment) => deployment.environment.id === targetEnvId
                );

                if (!envToApprove) {
                  core.setFailed(
                    `Environment ID ${targetEnvId} not found in pending deployments for run ${targetRun.id}.`
                  );
                  return;
                }

                await approveDeployment();
              } catch (error) {
                core.setFailed(
                  `Failed to review pending deployments for run ID ${targetRun.id}: ${error.message}`
                );
                throw error;
              }
            }
          }
        } catch (error) {
          core.setFailed(
            `Failed to process approval for workflow '${workflow}': ${error.message}`
          );
          throw error;
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
    await processWorkflowApprovals(allWorkflows);
  }

  console.log("Checkbox analysis script complete.");
};
