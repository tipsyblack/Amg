import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import type { VideoData } from "../types";
import { Scene } from "./Scene";

export const calculateVideoMetadata: CalculateMetadataFunction<
  VideoData
> = async ({ props }) => {
  const durationInFrames = Math.max(
    props.scenes.reduce((sum, scene) => sum + scene.durationInFrames, 0),
    1,
  );

  return {
    durationInFrames,
    fps: props.fps,
    width: props.width,
    height: props.height,
  };
};

export const VideoComposition: React.FC<VideoData> = ({
  scenes,
  musicFileName,
}) => {
  let startFrame = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#ffffff" }}>
      {musicFileName && (
        <Audio
          src={staticFile(`music/${musicFileName}`)}
          volume={0.12}
          loop
        />
      )}
      {scenes.map((scene, index) => {
        const from = startFrame;
        startFrame += scene.durationInFrames;

        return (
          <Sequence
            key={`${scene.audioFileName}-${index}`}
            from={from}
            durationInFrames={scene.durationInFrames}
          >
            <Scene caption={scene.caption} imageFileName={scene.imageFileName} />
            <Audio src={staticFile(`audio/${scene.audioFileName}`)} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
