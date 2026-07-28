import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import type { VideoData } from "../types";
import { CutTransition } from "./CutTransition";
import { Scene } from "./Scene";
import { TransitionBlur } from "./TransitionBlur";
import { MIX } from "./mix";
import { sceneMotion, transitionFrames } from "./transitions";

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
  fps,
  musicFileName,
  sfxEnabled = true,
  motionBlurEnabled = true,
  subtitlesEnabled = true,
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
        // Длина стыка теперь своя у каждого перехода: мягкий идёт дольше
        // резкого. Стык index→index+1 описан движением сцены index, поэтому
        // перекрытие берём у неё, а проявление входящей — у предыдущей.
        const exitFrames = transitionFrames(sceneMotion(index), fps);
        const enterFrames =
          index === 0 ? 0 : transitionFrames(sceneMotion(index - 1), fps);
        const visualDuration = isLast
          ? scene.durationInFrames
          : scene.durationInFrames + exitFrames;

        // Переходы из библиотеки задаются уходящей сценой: стык index→index+1
        // описан в sceneMotion(index).library. Входящая сцена узнаёт о нём,
        // чтобы не добавлять сверху своё движение и своё проявление.
        const exitingLibrary = isLast
          ? undefined
          : sceneMotion(index).library;
        const enteringLibrary =
          index === 0 ? undefined : sceneMotion(index - 1).library;
        const exitStartFrame = isLast
          ? visualDuration
          : scene.durationInFrames;

        return (
          <React.Fragment key={`${scene.audioFileName}-${index}`}>
            <Sequence from={from} durationInFrames={visualDuration}>
              <CutTransition
                entering={enteringLibrary}
                exiting={exitingLibrary}
                transitionFrames={enterFrames || exitFrames}
                exitStartFrame={exitStartFrame}
                visualDuration={visualDuration}
              >
                <TransitionBlur
                  enterFrames={enterFrames}
                  exitStartFrame={exitStartFrame}
                  disabled={
                    !motionBlurEnabled ||
                    Boolean(enteringLibrary || exitingLibrary)
                  }
                >
                  <Scene
                    words={subtitlesEnabled ? scene.words : undefined}
                    overlay={scene.overlay}
                    imageFileName={scene.imageFileName}
                    imageWidth={scene.imageWidth}
                    imageHeight={scene.imageHeight}
                    sceneIndex={index}
                    fadeInFrames={enteringLibrary ? 0 : enterFrames}
                    visualDuration={visualDuration}
                    exitStartFrame={exitStartFrame}
                    plainEntry={Boolean(enteringLibrary)}
                    plainExit={Boolean(exitingLibrary)}
                  />
                </TransitionBlur>
              </CutTransition>
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
