{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.chromium
    # Fonts so text renders in screenshots.
    pkgs.dejavu_fonts
    pkgs.fontconfig
  ];
}
