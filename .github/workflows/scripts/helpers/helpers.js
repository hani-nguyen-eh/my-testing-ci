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
    return envId;
  },
  createWorkflowRegex: (checkboxName, isChecked) => {
    const escapedCheckboxName = RegExp.escape(checkboxName);

    const checkboxMarker = isChecked
      ? "\\[\\s*[xX]\\s*\\]" // Matches [x] or [X]
      : "\\[\\s*\\]"; // Matches [ ]

    // More readable pattern construction
    const pattern = [
      checkboxMarker, // [ ] or [x]
      "\\s*`", // whitespace and opening backtick
      escapedCheckboxName, // escaped workflow name
      "`\\s*on\\s*GitHub\\s*Actions\\s*at\\s*this\\s*\\[workflow\\]", // rest of the pattern
    ].join("");

    return new RegExp(pattern);
  },
};
