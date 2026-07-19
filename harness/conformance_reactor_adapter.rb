# frozen_string_literal: true

require "net/http"
require "socket"
require "timeout"
require "tmpdir"

# Adapter for the capsium-webextension reactor (user-side, browser
# extension): starts one `node harness/serve.mjs PACKAGE` process per
# fixture, passing --store/--decryption-key as needed. The harness is the
# node bridge: it activates the package through the extension's own core
# modules (package loader with SHA-256 integrity, §6a signature and §6b
# decryption verification, resolver with §5a layers and §4a composites)
# running the real CapsiumService with in-memory DI ports, and serves the
# resolved content over node:http on an ephemeral port. A package the
# reactor rejects (tampered, bad signature, encrypted without the key, an
# unsatisfiable declared dependency) exits the child before it answers
# HTTP, which this adapter reports as StartError.
#
# Requires `npm ci && npm run harness:build` to have run in this
# repository (the harness is bundled from harness/serve.ts with esbuild).
#
# The `deploy:` serve option (authentication fixture) is not honored: the
# extension's §4b gate is a same-origin browser credential flow without
# reactor-side roles/deploy config, so the `authentication` class is not
# claimed and the kit never passes it.
class ReactorAdapterUnderTest < CapsiumConformance::ReactorAdapter
  REPO_ROOT = File.expand_path("..", __dir__)
  SERVE = File.join(REPO_ROOT, "harness", "serve.mjs")
  DEFAULT_TIMEOUT = 20
  STOP_TIMEOUT = 5

  def start(package_path, **options)
    port = options[:port] || free_port
    timeout = options[:timeout] || DEFAULT_TIMEOUT
    @port = port
    @log = File.join(Dir.mktmpdir, "capsium-webextension-reactor.log")
    @pid = spawn_harness(options.fetch(:env, {}),
                         command_line(package_path, options))
    wait_until_ready(timeout)
    "http://127.0.0.1:#{@port}"
  rescue StartError
    stop
    raise
  end

  def stop
    return unless @pid

    terminate
    @pid = nil
  end

  private

  def command_line(package_path, options)
    cmd = [node_binary, SERVE, package_path, "--port", @port.to_s]
    cmd += ["--store", options[:store].to_s] if options[:store]
    if options[:decryption_key]
      cmd += ["--decryption-key", options[:decryption_key].to_s]
    end
    cmd
  end

  def node_binary
    ENV.fetch("CAPSIUM_NODE", "node")
  end

  def spawn_harness(env, command_line)
    Process.spawn(env, *command_line,
                  out: @log, err: @log, pgroup: true)
  end

  # Polls the port until the harness answers HTTP; raises StartError when
  # the process exits first (a rejected package) or time runs out.
  def wait_until_ready(timeout)
    Timeout.timeout(timeout) do
      loop do
        return if ready?
        raise StartError, failure_message if exited?

        sleep(0.1)
      end
    end
  rescue Timeout::Error
    raise StartError, "reactor did not become ready within #{timeout}s " \
                      "(port #{@port}); log:\n#{log_tail}"
  end

  def ready?
    response = Net::HTTP.get_response(URI("http://127.0.0.1:#{@port}/"))
    !response.nil?
  rescue Errno::ECONNREFUSED, Errno::ECONNRESET, EOFError, SocketError
    false
  end

  def exited?
    @exited ||= !Process.wait(@pid, Process::WNOHANG).nil?
  rescue Errno::ECHILD
    @exited = true
  end

  def failure_message
    "reactor exited before serving (port #{@port}); log:\n#{log_tail}"
  end

  def log_tail
    File.file?(@log) ? File.read(@log).strip.lines.last(15).join : "(no log)"
  end

  def terminate
    Process.kill("TERM", -@pid)
    Timeout.timeout(STOP_TIMEOUT) { Process.wait(@pid) }
  rescue Errno::ESRCH, Errno::ECHILD, Timeout::Error
    force_kill
  end

  def force_kill
    begin
      Process.kill("KILL", -@pid)
    rescue Errno::ESRCH
      nil
    end
    begin
      Process.wait(@pid)
    rescue Errno::ECHILD
      nil
    end
  end

  def free_port
    server = TCPServer.new("127.0.0.1", 0)
    server.addr[1]
  ensure
    server&.close
  end
end
