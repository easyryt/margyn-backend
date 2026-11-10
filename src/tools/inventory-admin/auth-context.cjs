// Margyn checks the HttpOnly session before binding a private inventory workspace.
// Source role guards still run, using that workspace's owner identity.
module.exports = (allowed = []) => (req, res, next) => {
  const user = req.inventoryIdentity;
  if (!user) return res.status(401).json({ message: "Please sign in to continue." });
  if (allowed.length && !allowed.includes(user.role)) return res.status(403).json({ message: "This inventory role is not allowed." });
  req.user = user;
  next();
};
