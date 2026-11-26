class Teaminal < Formula
  desc "Lightweight terminal Microsoft Teams client"
  homepage "https://github.com/damsleth/teaminal"
  version "0.26.0"
  license "MIT"

  depends_on "damsleth/tap/owa-piggy" => :recommended

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-arm64.tar.gz"
      sha256 "ce670701a78358f64a1ccd242ac32abfa32fafebe7fa9244b3de282d08cd22c9"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-x64.tar.gz"
      sha256 "51d64e844839df06c6b8828c6534e8c64c1f05f419896545435b009037f92559"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-arm64.tar.gz"
      sha256 "37d1ef9c54b2135f8119be02b7227966f32b70490358b36d5d6977ebf0a89d07"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-x64.tar.gz"
      sha256 "099f74454204c7c727d79cf2e1f49e9864977de322978a1c95da4caa2f7e7f5c"
    end
  end

  def install
    bin.install "teaminal"
  end

  test do
    assert_match "teaminal #{version}", shell_output("#{bin}/teaminal --version")
  end
end
