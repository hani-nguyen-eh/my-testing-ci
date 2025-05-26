// helper to get the environment ID for a workflow
module.exports = {
  getEnvIdForWorkflow: ({ workflow }) => {
    const envName = environmentMappings[workflow];
    if (!envName) {
      console.log(`No environment mapping found for workflow: ${workflow}`);
      return null;
    }
    const envId = environmentIds[envName];
    return envId;
  },
};
