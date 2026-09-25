class Teaminal < Formula
  desc "Lightweight terminal Microsoft Teams client"
  homepage "https://github.com/damsleth/teaminal"
  version "0.23.0"
  license "MIT"

  depends_on "damsleth/tap/owa-piggy" => :recommended

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-arm64.tar.gz"
      sha256 "a8ed609bc9954bf39efa50bfe1b49ca531e1ccb191d7d1b2f287ce77d873dafa"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-x64.tar.gz"
      sha256 "fb3ffafe531e1117e43677b8bbf0c045ab75591f32ee90c099f8ab7faa402cee"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-arm64.tar.gz"
      sha256 "9ef37cb5fb59c67dbf7a2c302041fe3fcac4615231e6e6503a23a0e0e49e95db"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-x64.tar.gz"
      sha256 "98997446cbd05f8886e86caa70af1b0430f29ac57fcb8fefe501bd494e19a1cd"
    end
  end

  def install
    bin.install "teaminal"
  end

  test do
    assert_match "teaminal #{version}", shell_output("#{bin}/teaminal --version")
  end
end
