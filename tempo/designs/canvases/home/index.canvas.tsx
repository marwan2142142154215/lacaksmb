// @tempo-home — Tempo home canvas (the workspace Run button opens this). Managed marker; do not remove.
//
// One storyboard rendering your app's home route ("/"). Run (workspace header)
// opens this canvas beside your app's dev-server logs. Set the app dev command
// (set_app_dev_command) so the "/" route renders here.

import { Canvas, RouteStoryboard } from "tempo-sdk/canvas";

export default function HomeCanvas() {
  return (
    <Canvas name="Home">
      <RouteStoryboard
        id="Home"
        name="Home (/)"
        route="/"
        layout={{ x: 0, y: 0, width: 1280, height: 832 }}
      />
      <RouteStoryboard
        id="Devices"
        name="Perangkat"
        route="/devices"
        layout={{ x: 1320, y: 0, width: 1280, height: 832 }}
      />
      <RouteStoryboard
        id="Commands"
        name="Pusat perintah"
        route="/commands"
        layout={{ x: 2640, y: 0, width: 1280, height: 832 }}
      />
      <RouteStoryboard
        id="Enrollment"
        name="Android Enterprise"
        route="/enrollment"
        layout={{ x: 3960, y: 0, width: 1280, height: 832 }}
      />
      <RouteStoryboard
        id="Integrations"
        name="Integrasi & akses"
        route="/integrations"
        layout={{ x: 5280, y: 0, width: 1280, height: 832 }}
      />
    </Canvas>
  );
}
