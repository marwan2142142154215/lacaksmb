import { FileDiff } from "./_ui/icons";
import { DocsHero } from "./DocsHero";
import { DocsToDesignHero } from "./DocsToDesignHero";
import { ContextHero } from "./ContextHero";
import { Strip } from "./Strip";
import { ChatHero } from "./ChatHero";
import { WorkspaceNavSection } from "./WorkspaceNavSection";
import { RunHero } from "./RunHero";
import { BuildHero } from "./BuildHero";
import { ShareHero } from "./ShareHero";
import {
  IssuesBoardHero,
  IssuePropertiesHero,
  IssueChatHero,
} from "./IssuesHero";
import { ModelsHero } from "./ModelsHero";
import Storyboard3Component from "./Storyboard3";
import Storyboard1Component from "./Storyboard1";
import { Canvas, Storyboard } from "tempo-sdk/canvas";

const Plan = () => (
    <div className="wtt">
      <Strip
        number="1"
        accent="kiwi"
        title="Generate beautiful designs with Tempo"
        intro="Type up a brief and watch Tempo craft canvases that follow your design systems in seconds. Have the agent generate HTML designs or functional React prototypes, your pick."
        graphics={[
          { node: <ChatHero />, kind: "bare" },
          { node: <ContextHero />, kind: "bare" },
          { node: <RunHero />, kind: "bare" },
        ]}
      />
    </div>
  );

const Design = () => (
    <div className="wtt">
      <Strip
        number="2"
        accent="kiwi"
        title="Write the spec, then turn it into a design"
        intro="Draft PRDs and specs in a clean editor and keep them organized in one place — then collaborate with your team live, editing together in real time."
        graphics={[
          { node: <DocsHero />, kind: "bare" },
          { node: <DocsToDesignHero />, kind: "bare" },
        ]}
      />
    </div>
  );

const Build = () => (
    <div className="wtt">
      <Strip
        number="3"
        accent="blueberry"
        title="It's all real code in real git"
        intro={
          <>
            Each feature lives in its own workspace, a git branch with multiple
            chats.
            <br />
            Manage them under Chat, click{" "}
            <span className="whitespace-nowrap">
              <FileDiff className="mr-1 inline-block size-[1em] -translate-y-[1.5px] text-text-secondary" />
              Source Control
            </span>{" "}
            to track your file changes.
          </>
        }
        graphics={[
          { node: <BuildHero />, kind: "bare" },
          { node: <ShareHero />, kind: "bare" },
        ]}
      />
    </div>
  );

const Track = () => (
    <div className="wtt">
      <Strip
        number="4"
        accent="kiwi"
        title="Organize the work as issues"
        graphics={[
          { node: <IssuesBoardHero />, kind: "bare" },
          { node: <IssueChatHero />, kind: "bare" },
        ]}
      />
    </div>
  );

const Models = () => (
    <div className="wtt">
      <Strip
        number="6"
        accent="blueberry"
        title="Use any model through OpenCode"
        graphics={[{ node: <ModelsHero />, kind: "bare" }]}
      />
    </div>
  );

const ExploreTabs = () => (
    <div className="wtt">
      <WorkspaceNavSection />
    </div>
  );

const Storyboard3 = () => (
    <div className="wtt">
      <Storyboard3Component />
    </div>
  );

export default function WelcomeToTempoCanvas() {
  return (
    <Canvas name="Welcome to Tempo">
      <Storyboard
        id="Plan"
        name="1 · Generate"
        component={Plan}
        layout={{ x: 0, y: 0, width: 660, height: 1395 }}
      />
      <Storyboard
        id="Design"
        name="2 · Docs"
        component={Design}
        layout={{ x: 690, y: 0, width: 660, height: 1252 }}
      />
      <Storyboard
        id="Build"
        name="3 · Source control"
        component={Build}
        layout={{ x: 1383, y: 0, width: 660, height: 1221 }}
      />
      <Storyboard
        id="Track"
        name="4 · People + agents"
        component={Track}
        layout={{ x: 2079, y: 0, width: 660, height: 913 }}
      />
      <Storyboard
        id="Models"
        name="6 · Models"
        component={Models}
        layout={{ x: 3470, y: 0, width: 660, height: 614 }}
      />
      <Storyboard
        id="ExploreTabs"
        name="0 · Find your way around"
        component={ExploreTabs}
        layout={{ x: 2774, y: 0, width: 660, height: 577 }}
      />
      <Storyboard
        id="Storyboard3"
        name="Storyboard3"
        component={Storyboard3}
        layout={{ x: 0, y: -179, width: 533, height: 105 }}
      />
    </Canvas>
  );
}
