declare module "*.mjs" {
  export interface PdfViewport {
    readonly width: number;
    readonly height: number;
  }

  export interface PdfTextItem { readonly str: string }
  export interface PdfTextContent { readonly items: readonly PdfTextItem[] }
  export interface PdfRenderTask { readonly promise: Promise<void>; readonly cancel: () => void }
  export interface PdfPage {
    readonly getViewport: (options: { readonly scale: number }) => PdfViewport;
    readonly getTextContent: () => Promise<PdfTextContent>;
    readonly render: (options: { readonly canvasContext: CanvasRenderingContext2D; readonly viewport: PdfViewport; readonly transform: readonly [number, number, number, number, number, number] | null }) => PdfRenderTask;
  }
  export interface PdfOutlineItem { readonly dest: unknown; readonly title: string; readonly items: readonly PdfOutlineItem[] }
  export interface PdfDocument {
    readonly numPages: number;
    readonly getPage: (pageNumber: number) => Promise<PdfPage>;
    readonly getOutline: () => Promise<readonly PdfOutlineItem[] | null>;
    readonly getDestination: (destination: string) => Promise<readonly unknown[] | null>;
    readonly getPageIndex: (reference: unknown) => Promise<number>;
    readonly destroy?: () => unknown;
  }
  export interface PdfLoadingTask { readonly promise: Promise<PdfDocument>; readonly destroy: () => unknown }
  export const GlobalWorkerOptions: { workerSrc: string };
  export const getDocument: (options: { readonly url: string; readonly disableRange: boolean; readonly disableStream: boolean; readonly disableAutoFetch: boolean }) => PdfLoadingTask;
  export class TextLayer { public constructor(options: { readonly textContentSource: PdfTextContent; readonly container: HTMLDivElement; readonly viewport: PdfViewport }); public render(): Promise<void>; }
}
