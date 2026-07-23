{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  packages = with pkgs; [
    binaryen
    deno
    pkg-config
    rustup
    wasm-pack
  ];

  shellHook = ''
    export PATH="$PATH:''${CARGO_HOME:-$HOME/.cargo}/bin"

    if ! rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$'; then
      echo "mix playground: run 'rustup target add wasm32-unknown-unknown' once before building"
    fi

    echo "mix playground: cd web && deno task dev"
  '';
}

