import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import type { VideoData } from "../types";
import { Scene } from "./Scene";
import { sceneMotion } from "./transitions";

// Длина перекрытия сцен. Держим коротким и меньше запаса тишины в конце
// озвучки, чтобы переход накладывался на паузу, а не на речь. Тайминг аудио
// при этом не сдвигается: сцены остаются на своих кадрах.
const CROSSFADE_FRAMES = 8;

// Звук перехода играет на кадр раньше стыка: он резкий и короткий, поэтому
// должен попасть точно в начало движения. Большее опережение слышалось бы как
// отдельный звук «до» перехода.
const SFX_LEAD_FRAMES = 1;
// Щелчки и хлопки короткие, поэтому на слух тише длинных вушей — компенсируем
// громкостью, оставаясь под озвучкой.
const SFX_VOLUME = 0.5;

// Звук хука на первом кадре: подъём и удар под наезд карточки. Громче
// переходных — он должен остановить палец на пролистывании.
const HOOK_SFX_VOLUME = 0.42;

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
        <Audio src={staticFile(`music/${musicFileName}`)} volume={0.12} loop />
      )}
      {sfxEnabled && (
        <Sequence from={0}>
          <Audio src={staticFile("sfx/hook.wav")} volume={HOOK_SFX_VOLUME} />
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
                  from + scene.durationInFrames - SFX_LEAD_FRAMES,
                  0,
                )}
              >
                <Audio
                  src={staticFile(`sfx/${sceneMotion(index).sfx}.wav`)}
                  volume={SFX_VOLUME}
                />
              </Sequence>
            )}
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};
