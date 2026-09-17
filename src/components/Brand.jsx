import React, { useState } from "react";

// Company branding (T. Mangharam). Uses /tm-logo.png + /tm-wordmark.png from
// public/, with a graceful text fallback if the wordmark file isn't present.
export default function Brand({ variant = "header" }) {
  const [logoOk, setLogoOk] = useState(true);
  const [markOk, setMarkOk] = useState(true);

  return (
    <div className={`brand brand-${variant}`}>
      {logoOk && (
        <img
          className="brand-logo"
          src="/tm-logo.png"
          alt="T. Mangharam"
          onError={() => setLogoOk(false)}
        />
      )}
      {variant === "login" && (
        markOk ? (
          <img
            className="brand-wordmark"
            src="/tm-wordmark.png"
            alt="T. Mangharam"
            onError={() => setMarkOk(false)}
          />
        ) : (
          <span className="brand-wordmark-text">T.&thinsp;MANGHARAM</span>
        )
      )}
    </div>
  );
}
