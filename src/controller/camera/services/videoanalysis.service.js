'use-strict';

const _ = require('lodash');
const P2P = require('pipe2pam');
const PamDiff = require('pam-diff');
const { spawn } = require('child_process');

const { Ping } = require('../../../common/ping');

const { LoggerService } = require('../../../services/logger/logger.service');
const { ConfigService } = require('../../../services/config/config.service');

const { MotionController } = require('../../motion/motion.controller');

const { log } = LoggerService;

class VideoAnalysisService {
  #camera;
  #socket;
  #prebufferService;

  killed = false;

  cameraState = true;
  restartTimer = null;
  watchdog = null;

  motionTriggered = false;

  constructor(camera, prebufferService, socket) {
    //log.debug('Initializing video analysis', camera.name);

    this.#camera = camera;
    this.#socket = socket;
    this.#prebufferService = prebufferService;

    this.cameraName = camera.name;
  }

  reconfigure(camera) {
    const oldVideoConfig = this.#camera.videoConfig;
    const newVideoConfig = camera.videoConfig;

    this.#camera = camera;
    this.cameraName = camera.name;

    if (!_.isEqual(oldVideoConfig, newVideoConfig) && this.videoanalysisSession) {
      log.info('Motion: Video Config changed!', this.cameraName);
      this.restart();
    }
  }

  async start() {
    try {
      this.resetVideoAnalysis();

      this.cameraState = await this.#pingCamera();

      if (!this.cameraState) {
        log.warn(
          'Can not start video analysis, camera not reachable. Trying again in 60s..',
          this.cameraName,
          'videoanalysis'
        );

        this.stop(true);
        setTimeout(() => this.start(), 60000);

        return;
      }

      this.videoanalysisSession = await this.#startVideoAnalysis();

      const midnight = this.#millisUntilMidnight();
      const timer = midnight + 3 * 60 * 60 * 1000;

      log.info(`Videoanalysis scheduled for restart at 3AM: ${Math.round(timer / 1000 / 60)} minutes`, this.cameraName);

      this.restartTimer = setTimeout(() => {
        log.info('Sheduled restart of videoanalysis is executed...', this.cameraName);
        this.restart();
      }, timer);
    } catch (error) {
      if (error) {
        log.info('An error occured during starting videoanalysis!', this.cameraName, 'videoanalysis');
        log.error(error, this.cameraName, 'videoanalysis');
      }
    }
  }

  resetVideoAnalysis() {
    this.stop(true);

    this.videoanalysisSession = null;
    this.killed = false;
    this.cameraState = true;
    this.restartTimer = null;
    this.watchdog = null;
    this.motionTriggered = false;
  }

  stop(killed) {
    if (this.videoanalysisSession) {
      if (killed) {
        this.killed = true;
      }

      if (this.watchdog) {
        clearTimeout(this.watchdog);
      }

      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }

      this.videoanalysisSession.cp?.kill('SIGKILL');
      this.videoanalysisSession = undefined;
    }
  }

  restart() {
    log.info('Restart videoanalysis session..', this.cameraName);
    this.stop(true);
    setTimeout(() => this.start(), 10000);
  }

  async #startVideoAnalysis() {
    if (this.videoanalysisSession) {
      return this.videoanalysisSession;
    }

    let isActive = true;

    log.debug('Start videoanalysis...', this.cameraName);

    let input = this.#camera.videoConfig.subSource.split(/\s+/);

    if (this.#camera.prebuffering) {
      try {
        input = await this.#prebufferService.getVideo();
      } catch {
        // ignore

        if (this.#camera.videoConfig.mapvideo) {
          input.push('-map', this.#camera.videoConfig.mapvideo);
        }
      }
    }

    const ffmpegArguments = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...input,
      '-an',
      '-vcodec',
      'pam',
      '-pix_fmt',
      'gray',
      '-f',
      'image2pipe',
      '-vf',
      'fps=2,scale=400:225',
      'pipe:1',
    ];

    log.debug(
      `Videoanalysis command: ${ConfigService.ui.options.videoProcessor} ${ffmpegArguments.join(' ')}`,
      this.cameraName
    );

    const errors = [];

    const p2p = new P2P();
    const pamDiff = new PamDiff({ difference: 10, percent: 10, response: 'blobs', draw: true });

    const restartWatchdog = () => {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        log.error('Watchdog for videoanalysis timed out... killing ffmpeg session', this.cameraName, 'videoanalysis');
        cp?.kill('SIGKILL');

        isActive = false;
      }, 15000);
    };

    p2p.on('pam', () => {
      restartWatchdog();

      this.#socket.emit('videoanalysisStatus', {
        camera: this.cameraName,
        status: 'active',
      });

      isActive = true;
    });

    // eslint-disable-next-line no-unused-vars
    pamDiff.on('diff', async (data) => {
      if (!this.motionTriggered) {
        this.motionTriggered = true;

        const result = await MotionController.handleMotion('motion', this.cameraName, true, 'videoanalysis', {});
        log.debug(`Received a new VIDEOANALYSIS message ${JSON.stringify(result)} (${this.cameraName})`);

        setTimeout(() => {
          this.motionTriggered = false;
        }, 30000);
      }
    });

    const cp = spawn(ConfigService.ui.options.videoProcessor, ffmpegArguments, {
      env: process.env,
    });

    cp.stderr.on('data', (data) => errors.push(data.toString().replace(/(\r\n|\n|\r)/gm, '')));

    cp.on('exit', (code, signal) => {
      isActive = false;

      if (code === 1) {
        errors.unshift(`FFmpeg videoanalysis process exited with error! (${signal})`);
        log.error(errors.join(' - '), this.cameraName, 'videoanalysis');
      } else {
        log.debug('FFmpeg videoanalysis process exited (expected)', this.cameraName);
      }
    });

    cp.on('close', () => {
      isActive = false;

      log.debug('Videoanalysis process closed', this.cameraName);

      this.#socket.emit('videoanalysisStatus', {
        camera: this.cameraName,
        status: 'inactive',
      });

      if (!this.killed) {
        this.restart();
      }
    });

    cp.stdout.pipe(p2p).pipe(pamDiff);

    restartWatchdog();

    return {
      isActive() {
        return isActive;
      },
      cp,
    };
  }

  #millisUntilMidnight() {
    const midnight = new Date();
    midnight.setHours(24);
    midnight.setMinutes(0);
    midnight.setSeconds(0);
    midnight.setMilliseconds(0);
    return midnight.getTime() - Date.now();
  }

  async #pingCamera() {
    let state = true;

    try {
      state = await Ping.status(this.#camera, 1);
    } catch (error) {
      log.info('An error occured during pinging camera, skipping..', this.cameraName);
      log.error(error, this.cameraName);
    }

    return state;
  }
}

exports.VideoAnalysisService = VideoAnalysisService;