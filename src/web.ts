import express, { type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";

export function mountWeb(app: Express, directory: string) {
  const index = path.resolve(directory, "index.html");
  if (!existsSync(index)) return;
  app.use(
    "/assets",
    express.static(path.resolve(directory, "assets"), {
      immutable: true,
      maxAge: "1y",
      index: false,
      redirect: false,
    }),
  );
  app.use(
    express.static(directory, { index: false, maxAge: 0, redirect: false }),
  );
  app.get(["/", "/join"], (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile("index.html", { root: path.resolve(directory) });
  });
}
