// Optional controls for existing components whose source should stay untouched.
// New components always keep defineControls in their own file.
// For existing components, honor the user/repo preference; fully integrated apps
// prefer component files. Non-dev work can use this file; ask developers if unsure.
// Both locations work across canvases without asset registration.
// Import app components here, and import defineControls from "tempo-sdk/assets".
// Example (adjust the import to your app):
// import { defineControls } from "tempo-sdk/assets";
// import { Button } from "../src/components/Button";
// defineControls(Button, { disabled: { type: "boolean" } });
// Keep one declaration per component; move existing declarations rather than copying them.
// Tempo discovers this file automatically. Do not import it into app or canvas entry points.
export {};
