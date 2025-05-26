function escapeRegExp(string) {
  if (typeof string !== "string") {
    return "";
  }
  return string.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

module.exports = { escapeRegExp };
