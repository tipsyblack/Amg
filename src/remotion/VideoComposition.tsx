import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import type { VideoData } from "../types";
import { CutTransition } from "./CutTransition";
import { Outro } from "./Outro";
import { PersistentOverlay } from "./PersistentOverlay";
import { Scene } from "./Scene";
import { TransitionBlur } from "./TransitionBlur";
import { MIX } from "./mix";
import { coversFrame, sceneMotion, transitionFrames } from "./transitions";

// Сколько сквозной объект держится уже на новой сцене и сколько гаснет.
// Держать дольше секунды нельзя: предмет из прошлой сцены быстро перестаёт
// быть уместным, а связка двух кадров читается почти сразу.
const PERSIST_HOLD_SECONDS = 0.9;
const PERSIST_FADE_SECONDS = 0.35;

export const calculateVideoMetadata: CalculateMetadataFunction<
  VideoData
> = async ({ props }) => {
  const durationInFrames = Math.max(
    props.scenes.reduce((sum, scene) => sum + scene.durationInFrames, 0) +
      (props.outro?.durationInFrames ?? 0),
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
  outro,
  musicFileName,
  sfxEnabled = true,
  // См. комментарий в types.ts: в референсе акцентов нет.
  accentsEnabled = false,
  motionBlurEnabled = true,
  subtitlesEnabled = true,
}) => {
  // Начала сцен считаем заранее: они нужны и в самой раскладке, и в слое
  // сквозных объектов, который рисуется отдельно и позже.
  const starts: number[] = [];
  scenes.reduce((acc, scene) => {
    starts.push(acc);
    return acc + scene.durationInFrames;
  }, 0);
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
        // Следующая сцена сама закрывает кадр — своего ухода этой не нужно.
        const nextCovers = !isLast && coversFrame(sceneMotion(index + 1));
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
                    // Сквозной объект рисуется отдельным слоем поверх
                    // обеих сцен, а не внутри этой — иначе он ушёл бы вместе
                    // с ней ровно тогда, когда должен остаться.
                    overlay={
                      scene.overlay?.acrossCut ? undefined : scene.overlay
                    }
                    imageFileName={scene.imageFileName}
                    imageWidth={scene.imageWidth}
                    imageHeight={scene.imageHeight}
                    swapImageFileName={scene.swapImageFileName}
                    swapStartMs={scene.swapStartMs}
                    accentsEnabled={accentsEnabled}
                    mascotOnly={scene.mascotOnly}
                    clipFileName={scene.clipFileName}
                    clipDurationInFrames={scene.clipDurationInFrames}
                    sceneIndex={index}
                    fadeInFrames={enteringLibrary ? 0 : enterFrames}
                    visualDuration={visualDuration}
                    exitStartFrame={exitStartFrame}
                    plainEntry={Boolean(enteringLibrary)}
                    plainExit={Boolean(exitingLibrary) || nextCovers}
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

      {/* Брендовая концовка идёт после последней сцены, отдельным кадром. */}
      {outro && (
        <Sequence
          from={scenes.reduce((sum, scene) => sum + scene.durationInFrames, 0)}
          durationInFrames={outro.durationInFrames}
        >
          <Outro
            outro={outro}
            enterFrames={Math.round(MIX.sharpTransitionSeconds * fps)}
          />
        </Sequence>
      )}

      {/* Сквозные объекты — последними в дереве, то есть поверх всех сцен.
          Внутри карты сцен они не работали: следующая сцена — это Sequence
          ниже по дереву, она рисуется выше и закрывала объект ровно на том
          стыке, который он должен пережить. */}
      {scenes.map((scene, index) => {
        const overlay = scene.overlay;
        if (!overlay?.acrossCut || index === scenes.length - 1) return null;
        const appearFrame = Math.round((overlay.startMs / 1000) * fps);
        const total = Math.max(
          scene.durationInFrames -
            appearFrame +
            transitionFrames(sceneMotion(index), fps) +
            Math.round(PERSIST_HOLD_SECONDS * fps),
          1,
        );
        return (
          <Sequence
            key={`persist-${index}`}
            from={starts[index] + appearFrame}
            durationInFrames={total}
          >
            <PersistentOverlay
              overlay={overlay}
              fadeOutFrames={Math.round(PERSIST_FADE_SECONDS * fps)}
              totalFrames={total}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
