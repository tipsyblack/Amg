import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import type { VideoData } from "../types";
import { Scene } from "./Scene";
import { MIX } from "./mix";
import { sceneMotion } from "./transitions";

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
  sfxEnabled = true,
}) => {
  let startFrame = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#ffffff" }}>
      {musicFileName && (
        <Audio
          src={staticFile(`music/${musicFileName}`)}
          volume={MIX.music}
          loop
        />
      )}
      {sfxEnabled && (
        <Sequence from={0}>
          <Audio src={staticFile("sfx/hook.wav")} volume={MIX.hookSfx} />
        </Sequence>
      )}
      {scenes.map((scene, index) => {
        const from = startFrame;
        startFrame += scene.durationInFrames;

        // Уходящая сцена живёт на перекрытие дольше, а входящая проявляется
        // поверх неё: в Remotion следующая сцена рисуется выше и закрывает
        // предыдущую своим фоном, поэтому растворяться должна именно входящая.
        const isLast = index === scenes.length - 1;
        const visualDuration = isLast
          ? scene.durationInFrames
          : scene.durationInFrames + MIX.crossfadeFrames;

        return (
          <React.Fragment key={`${scene.audioFileName}-${index}`}>
            <Sequence from={from} durationInFrames={visualDuration}>
              <Scene
                caption={scene.caption}
                imageFileName={scene.imageFileName}
                imageWidth={scene.imageWidth}
                imageHeight={scene.imageHeight}
                sceneIndex={index}
                fadeInFrames={index === 0 ? 0 : MIX.crossfadeFrames}
                visualDuration={visualDuration}
                exitStartFrame={
                  isLast ? visualDuration : scene.durationInFrames
                }
              />
            </Sequence>
            {/* Аудио отдельной дорожкой: перекрытие картинки не должно
                смещать или обрезать озвучку. */}
            <Sequence from={from} durationInFrames={scene.durationInFrames}>
              <Audio src={staticFile(`audio/${scene.audioFileName}`)} />
            </Sequence>
            {/* Звук перехода на стыке со следующей сценой. */}
            {sfxEnabled && !isLast && (
              <Sequence
                from={Math.max(
                  from + scene.durationInFrames - MIX.sfxLeadFrames,
                  0,
                )}
              >
                <Audio
                  src={staticFile(`sfx/${sceneMotion(index).sfx}.wav`)}
                  volume={MIX.sfx}
                />
              </Sequence>
            )}
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};
