createWorkflowRegex: (checkboxName, isChecked) => {
  const escapedCheckboxName = checkboxName.replace(
    /[\\^$.*+?()[\]{}|]/g,
    "\\$&"
  );
  let checkboxMarkerPattern;

  if (isChecked) {
    checkboxMarkerPattern = "\\[\\s*[xX]\\s*\\]"; // Matches [x] or [X]
  } else {
    checkboxMarkerPattern = "\\[\\s*\\]"; // Matches [ ]
  }

  // Construct the full pattern string
  // Part 1: The checkbox marker (e.g., "[ ]" or "[x]") followed by a space and a backtick
  const part1 = checkboxMarkerPattern + "\\s*`";
  // Part 2: The rest of the pattern after the checkbox name and its closing backtick
  const part2 = "`\\s*on\\s*GitHub\\s*Actions\\s*at\\s*this\\s*\\[workflow\\]";

  const patternString = part1 + escapedCheckboxName + part2;

  return new RegExp(patternString);
};

module.exports = {
  splitWorkflows: ({ workflows }) => {
    if (!workflows) {
      return [];
    }

    return workflows.split(",").map((workflow) => workflow.trim());
  },
  getEnvIdForWorkflow: ({
    workflow,
    workflowDispatchConfig,
    environmentIds,
  }) => {
    const envName = workflowDispatchConfig[workflow];
    if (!envName) {
      console.log(`No environment mapping found for workflow: ${workflow}`);
      return null;
    }

    const envId = environmentIds[envName];
    if (!envId) {
      console.log(
        `Environment ID not found for environment name: ${envName} (workflow: ${workflow})`
      );
      return null;
    }

    console.log(
      `Found environment mapping: ${workflow} -> ${envName} (ID: ${envId})`
    );
    return Number(envId);
  },
  // Helper to check if a specific checkbox was toggled from unchecked to checked
  wasToggledOn: (checkboxName, workflowType, commentBody, previousBody) => {
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
  },

  // Fetch environment IDs from GitHub API
  fetchEnvironmentIds: async (github, owner, repo, core) => {
    console.log("Fetching environment IDs...");
    const environmentIds = {};

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
          environmentIds[env.name] = env.id;
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

    return environmentIds;
  },

  waitForWorkflowRunToBeReady: async ({
    core,
    github,
    owner,
    repo,
    runId,
    timeout,
    retryDelay,
  }) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const { data: run } = await github.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      const status = run.status;

      console.log(`Workflow run ${runId} status: ${status}`);
      if (status === "waiting") {
        console.log(`Workflow run ${runId} is 'waiting'. Ready for approval.`);
        return true;
      }

      if (status !== "pending") {
        core.warning(
          `Workflow run ${runId} has status '${status}', not 'pending' or 'waiting'. Aborting approval.`
        );
        return false;
      }

      console.log(
        `Workflow run ${runId} is 'pending', checking again in ${
          retryDelay / 1000
        }s...`
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }

    core.setFailed(
      `Timeout: Workflow run ${runId} did not become 'waiting' within ${
        timeout / 1000
      }s.`
    );
    return false;
  },
};
