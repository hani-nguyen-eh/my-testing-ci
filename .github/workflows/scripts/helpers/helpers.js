module.exports = {
  splitWorkflows: ({ workflows }) => {
    if (!workflows) {
      return [];
    }

    return workflows.split(",").map((workflow) => workflow.trim());
  },
  getEnvIdForWorkflow: ({ workflow, environmentMappings, environmentIds }) => {
    const envName = environmentMappings[workflow];
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
    const part2 =
      "`\\s*on\\s*GitHub\\s*Actions\\s*at\\s*this\\s*\\[workflow\\]";

    const patternString = part1 + escapedCheckboxName + part2;

    return new RegExp(patternString);
  },
};
