// Public build configuration only. Never put signing or billing secrets here.
module.exports = ({ config }) => {
  const release = process.env.SEENSNAP_RELEASE_BUILD === "true";
  if (release && (!process.env.SEENSNAP_EXPO_OWNER || !process.env.SEENSNAP_EAS_PROJECT_ID)) {
    throw new Error("Confirm SEENSNAP_EXPO_OWNER and SEENSNAP_EAS_PROJECT_ID before building for TestFlight.");
  }
  const projectId = process.env.SEENSNAP_EAS_PROJECT_ID || config.extra?.eas?.projectId;
  const owner = process.env.SEENSNAP_EXPO_OWNER || config.owner;
  return {
    ...config,
    owner,
    extra: { ...config.extra, ...(projectId ? { eas: { projectId } } : {}) },
  };
};
