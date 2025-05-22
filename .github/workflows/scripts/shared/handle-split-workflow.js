export const splitWorkflows = ({ workflows }) => {
  if (!workflows) {
    return [];
  }

  return workflows.split(",").map((workflow) => workflow.trim());
};
