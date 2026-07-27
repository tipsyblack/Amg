import React from "react";
import { Composition } from "remotion";
import { defaultVideoData, motionLabData, videoDataSchema } from "../types";
import { calculateVideoMetadata, VideoComposition } from "./VideoComposition";

const defaultDurationInFrames = defaultVideoData.scenes.reduce(
  (sum, scene) => sum + scene.durationInFrames,
  0,
);

const labData = motionLabData();
const labDuration = labData.scenes.reduce(
  (sum, scene) => sum + scene.durationInFrames,
  0,
);

export const RemotionRoot: React.FC = () => {
  return (
    <>
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
      {/* Стенд движения: все варианты входа, ухода, библиотечных переходов и
          акцентов в одном ролике. Нужен, чтобы править анимацию в Studio и
          сразу видеть результат, не запуская генерацию. */}
      <Composition
        id="MotionLab"
        component={VideoComposition}
        schema={videoDataSchema}
        defaultProps={labData}
        calculateMetadata={calculateVideoMetadata}
        durationInFrames={labDuration}
        fps={labData.fps}
        width={labData.width}
        height={labData.height}
      />
    </>
  );
};
