const { escapeRegExp } = require("./escapeRegExp.js");

/**
 * Creates a regular expression to match a workflow checkbox line.
 * @param {string} checkboxName - The name of the workflow (e.g., "build-preview").
 * @param {boolean} isChecked - True to generate a regex for a checked box, false for unchecked.
 * @returns {RegExp}
 */
function createWorkflowRegex(checkboxName, isChecked) {
  const escapedCheckboxName = escapeRegExp(checkboxName);
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

  // Optional debug log, can be uncommented if needed
  // console.log(`DEBUG Regex for "${checkboxName}" (isChecked: ${isChecked}): "${patternString}"`);

  return new RegExp(patternString);
}

module.exports = { createWorkflowRegex };
