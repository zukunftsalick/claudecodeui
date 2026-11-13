type HtmlPreviewFrameProps = {
  html: string;
  title: string;
};

// Scripts, forms and popups run so prototypes behave like the real page, but
// `allow-same-origin` is deliberately absent: the frame gets an opaque origin,
// so the previewed page can never read the app's cookies, storage or API.
const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';

/** Rendered by CodeEditorSurface inside the code-editor module to show an HTML file as a live, sandboxed page beside the chat. */
export default function HtmlPreviewFrame({ html, title }: HtmlPreviewFrameProps) {
  return (
    <div className="h-full w-full bg-white">
      <iframe
        title={title || 'HTML preview'}
        sandbox={HTML_PREVIEW_SANDBOX}
        srcDoc={html}
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}
