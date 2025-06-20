const { splitWorkflows } = require("./helpers/helpers.js");

module.exports = async ({ github, context, core }) => {
  const prNumber = parseInt(process.env.PR_NUMBER, 10);
  const commitHash = process.env.COMMIT_HASH;
  const headRef = process.env.HEAD_REF;
  const actionBot = process.env.ACTION_BOT || "hani-nguyen-eh";
  const requiredWorkflowsArray = splitWorkflows({
    workflows: process.env.REQUIRED_WORKFLOWS,
  });
  const optionalWorkflowsArray = splitWorkflows({
    workflows: process.env.OPTIONAL_WORKFLOWS,
  });
  const documentLink = process.env.DOCUMENT_LINK;

  if (
    isNaN(prNumber) ||
    !commitHash ||
    !headRef ||
    !requiredWorkflowsArray?.length
  ) {
    core.setFailed(
      "Missing or invalid required input: PR_NUMBER, COMMIT_HASH, HEAD_REF or REQUIRED_WORKFLOWS"
    );
    return;
  }

  const {
    repo: { owner, repo },
  } = context;
  const commentIdentifier = `<!-- workflow-triggers--${repo}-${prNumber} -->`;

  console.log(
    `Starting script for PR #${prNumber} on repo ${owner}/${repo} at commit ${commitHash}`
  );

  // 1. Find existing comment
  console.log(`Searching for existing comment by ${actionBot}...`);

  const findExistingComment = async () => {
    try {
      const allComments = await github.paginate(
        github.rest.issues.listComments,
        { owner, repo, issue_number: prNumber, per_page: 100 }
      );

      const foundComment = allComments.find(
        (comment) =>
          comment.user.login === actionBot &&
          comment.body.includes(commentIdentifier)
      );

      if (foundComment) {
        console.log(`Found existing comment with ID: ${foundComment.id}`);
        return foundComment.id;
      }
      return null;
    } catch (error) {
      core.setFailed(`Failed to list comments: ${error.message}`);
      throw error;
    }
  };

  const existingCommentId = await findExistingComment();

  // 2. Formulate the comment body
  console.log("Formulating the GitHub comment...");

  function generateWorkflowMarkdown(workflowName) {
    const workflowUrl = `https://github.com/${owner}/${repo}/actions/workflows/${workflowName}.yml?query=${encodeURIComponent(
      `branch:${headRef}`
    )}`;
    return `[ ] \`${workflowName}\` on GitHub Actions at this [workflow](${workflowUrl}).`;
  }

  function generateWorkflowMarkdownArray(workflowArr) {
    return workflowArr
      .map((workflow) => `- ${generateWorkflowMarkdown(workflow)}`)
      .join("\n");
  }

  // Use Intl for more robust timezone formatting
  const now = new Date();
  const options = {
    // Define options once
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "", // Placeholder
  };

  let dateHCM, timeHCM, dateSYD, timeSYD;
  try {
    options.timeZone = "Asia/Ho_Chi_Minh";
    const formatterHCM = new Intl.DateTimeFormat("en-VN", options);
    [dateHCM, timeHCM] = formatterHCM.format(now).split(", ");

    options.timeZone = "Australia/Sydney";
    const formatterSYD = new Intl.DateTimeFormat("en-AU", options);
    [dateSYD, timeSYD] = formatterSYD.format(now).split(", ");
  } catch (error) {
    core.warning(`Failed to format dates: ${error.message}`);
    // Provide fallback dates if formatting fails
    const fallbackDate = now.toISOString();
    [dateHCM, timeHCM] = [fallbackDate.split("T")[0], "(HCM Error)"];
    [dateSYD, timeSYD] = [fallbackDate.split("T")[0], "(SYD Error)"];
  }

  const messageBody = `# Workflow triggers ${commentIdentifier}\n
_For details on each workflow or feedback, please check out this [document](${documentLink})_

## Required
${generateWorkflowMarkdownArray(requiredWorkflowsArray)}

## Optional
${generateWorkflowMarkdownArray(optionalWorkflowsArray)}

_This comment is generated against commit ${commitHash}, updated at:_
- _${dateHCM} - ${timeHCM} (Asia/Ho Chi Minh)_
- _${dateSYD} - ${timeSYD} (Australia/Sydney)_`;

  // 3. Create or update comment
  try {
    if (existingCommentId) {
      console.log(`Updating existing comment ID ${existingCommentId}...`);
      await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingCommentId,
        body: messageBody,
      });
      console.log("Comment updated.");
    } else {
      console.log("Creating new comment...");
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: messageBody,
      });
      console.log("Comment created.");
    }
  } catch (error) {
    core.setFailed(`Failed to create/update comment: ${error.message}`);
  }
};
