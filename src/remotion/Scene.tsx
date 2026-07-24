import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { loadFont } from "@remotion/google-fonts/Anton";

const { fontFamily } = loadFont();

interface SceneProps {
  caption: string;
  imageFileName?: string;
}

// Разобрано по кадрам присланного референса:
// белый фон, скруглённая карточка в толстой чёрной рамке, под ней —
// жирная чёрная капслок-подпись. Смена сцен — жёсткий склей, без фейдов.
export const Scene: React.FC<SceneProps> = ({ caption, imageFileName }) => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#ffffff",
        alignItems: "center",
        paddingTop: "9%",
      }}
    >
      <div
        style={{
          width: "82%",
          aspectRatio: "0.74",
          border: "10px solid #0d0d0d",
          borderRadius: 28,
          overflow: "hidden",
          backgroundColor: "#ececeb",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {imageFileName ? (
          <Img
            src={staticFile(`images/${imageFileName}`)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div
            style={{
              fontFamily,
              fontSize: 32,
              color: "#9a9a97",
              textAlign: "center",
              padding: "0 10%",
            }}
          >
            изображение сцены
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: "6%",
          padding: "0 6%",
          fontFamily,
          fontSize: 84,
          lineHeight: 1.05,
          color: "#0d0d0d",
          textTransform: "uppercase",
          textAlign: "center",
        }}
      >
        {caption}
      </div>
    </AbsoluteFill>
  );
};
