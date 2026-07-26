import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import type { VideoData } from "../types";
import { Scene } from "./Scene";

// Длина перекрытия сцен. Держим коротким и меньше запаса тишины в конце
// озвучки (SCENE_PADDING_SECONDS = 0.4 c), чтобы кроссфейд накладывался на
// паузу, а не на речь. Тайминг аудио при этом не сдвигается: сцены остаются
// на своих кадрах, наплывает только картинка уходящей сцены.
const CROSSFADE_FRAMES = 7;

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
        <Audio src={staticFile(`music/${musicFileName}`)} volume={0.12} loop />
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
          : scene.durationInFrames + CROSSFADE_FRAMES;

        return (
          <React.Fragment key={`${scene.audioFileName}-${index}`}>
            <Sequence from={from} durationInFrames={visualDuration}>
              <Scene
                caption={scene.caption}
                imageFileName={scene.imageFileName}
                imageWidth={scene.imageWidth}
                imageHeight={scene.imageHeight}
                sceneIndex={index}
                fadeInFrames={index === 0 ? 0 : CROSSFADE_FRAMES}
                visualDuration={visualDuration}
              />
            </Sequence>
            {/* Аудио отдельной дорожкой: перекрытие картинки не должно
                смещать или обрезать озвучку. */}
            <Sequence from={from} durationInFrames={scene.durationInFrames}>
              <Audio src={staticFile(`audio/${scene.audioFileName}`)} />
            </Sequence>
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};
