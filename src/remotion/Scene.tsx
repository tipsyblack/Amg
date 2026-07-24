import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

interface SceneProps {
  caption: string;
  sceneIndex: number;
  totalScenes: number;
}

// Плейсхолдер-стиль. Как только придёт референс-видео от агентства,
// эта разметка заменяется на копию их переходов/шрифтов/тайминга.
export const Scene: React.FC<SceneProps> = ({
  caption,
  sceneIndex,
  totalScenes,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({ frame, fps, config: { damping: 200 } });
  const opacity = interpolate(entrance, [0, 1], [0, 1]);
  const translateY = interpolate(entrance, [0, 1], [40, 0]);

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(160deg, #1c1c26 0%, #0b0b0f 100%)",
      }}
    >
      <AbsoluteFill
        style={{
          justifyContent: "flex-start",
          alignItems: "center",
          padding: "60px 60px 0",
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          {Array.from({ length: totalScenes }).map((_, i) => (
            <div
              key={i}
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor:
                  i <= sceneIndex ? "#ffffff" : "rgba(255,255,255,0.25)",
              }}
            />
          ))}
        </div>
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "center",
          padding: "0 60px 180px",
        }}
      >
        <div
          style={{
            opacity,
            transform: `translateY(${translateY}px)`,
            fontFamily: "Arial, sans-serif",
            fontSize: 64,
            fontWeight: 800,
            color: "#ffffff",
            textAlign: "center",
            lineHeight: 1.15,
            textShadow: "0 4px 24px rgba(0,0,0,0.5)",
          }}
        >
          {caption}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
