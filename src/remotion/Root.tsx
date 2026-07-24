import React from "react";
import { Composition } from "remotion";
import { defaultVideoData, videoDataSchema } from "../types";
import { calculateVideoMetadata, VideoComposition } from "./VideoComposition";

const defaultDurationInFrames = defaultVideoData.scenes.reduce(
  (sum, scene) => sum + scene.durationInFrames,
  0,
);

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="VideoComposition"
      component={VideoComposition}
      schema={videoDataSchema}
      defaultProps={defaultVideoData}
      calculateMetadata={calculateVideoMetadata}
      durationInFrames={defaultDurationInFrames}
      fps={defaultVideoData.fps}
      width={defaultVideoData.width}
      height={defaultVideoData.height}
    />
  );
};
