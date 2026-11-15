import posthog from "posthog-js";

if (import.meta.env.PROD) {
  posthog.init(import.meta.env.VITE_POSTHOG_KEY, {
    api_host: import.meta.env.VITE_POSTHOG_HOST,
    // The router changes the URL without page loads, so count every navigation.
    capture_pageview: "history_change",
    capture_pageleave: true,
    autocapture: false,
    capture_exceptions: false,
    disable_session_recording: true,
    enable_heatmaps: false,
    disable_surveys: true,
    advanced_disable_feature_flags: true,
    person_profiles: "never",
  });
}

export { posthog };
