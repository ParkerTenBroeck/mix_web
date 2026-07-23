export const canvasExample = `args: {
  random = seed: salt:
    ((seed + 1) * (salt + 17) * 1103 + salt * 7919) % 65521;

  nonZero = value:
    if value == 0 then 1 else value;

  makeBall = seed: index: {
    x = 20 + ((random seed (index * 5 + 0)) % 520);
    y = 20 + ((random seed (index * 5 + 1)) % 200);
    dx = nonZero (((random seed (index * 5 + 2)) % 7) - 3);
    dy = nonZero (((random seed (index * 5 + 3)) % 7) - 3);
    hue = (random seed (index * 5 + 4)) % 360;
  };

  moveBall = ball: {
    dx =
      if (ball.x <= 15) || (ball.x >= 545)
      then -ball.dx
      else ball.dx;

    dy =
      if (ball.y <= 15) || (ball.y >= 225)
      then -ball.dy
      else ball.dy;

    x = ball.x + dx;
    y = ball.y + dy;
    hue = (ball.hue + 2) % 360;
  };

  state =
    if !args?state then
    {
      started = false;
      waitFrames = 0;
      seed = 0;
      balls = [];
      textX = 40;
      textY = 40;
    }
    else if !args.state.started then
      if args?input.keys." " then
      {
        started = true;
        waitFrames = args.state.waitFrames;
        seed = args.state.waitFrames;
        textX = args.state.textX;
        textY = args.state.textY;
        balls = [
          (makeBall seed 0),
          (makeBall seed 1),
          (makeBall seed 2),
          (makeBall seed 3),
          (makeBall seed 4),
          (makeBall seed 5),
          (makeBall seed 6),
          (makeBall seed 7),
          (makeBall seed 8),
          (makeBall seed 9)
        ];
      }
      else
      {
        started = false;
        waitFrames = args.state.waitFrames + 1;
        seed = 0;
        balls = [];
        textX = args.state.textX;
        textY = args.state.textY;
      }
    else
    {
      started = true;
      waitFrames = args.state.waitFrames;
      seed = args.state.seed;

      textX =
        if args?input.keys.a then
          if args.state.textX <= 8 then 8
          else args.state.textX - 4
        else if args?input.keys.d then
          if args.state.textX >= 395 then 395
          else args.state.textX + 4
        else
          args.state.textX;

      textY =
        if args?input.keys.w then
          if args.state.textY <= 22 then 22
          else args.state.textY - 4
        else if args?input.keys.s then
          if args.state.textY >= 195 then 195
          else args.state.textY + 4
        else
          args.state.textY;

      balls = [
        (moveBall args.state.balls.0),
        (moveBall args.state.balls.1),
        (moveBall args.state.balls.2),
        (moveBall args.state.balls.3),
        (moveBall args.state.balls.4),
        (moveBall args.state.balls.5),
        (moveBall args.state.balls.6),
        (moveBall args.state.balls.7),
        (moveBall args.state.balls.8),
        (moveBall args.state.balls.9)
      ];
    };

  hexDigits = [
    "0", "1", "2", "3",
    "4", "5", "6", "7",
    "8", "9", "a", "b",
    "c", "d", "e", "f"
  ];

  hexDigit = value:
    hexDigits.\${value};

  hexByte = value:
    (hexDigit (value / 16)) +
    (hexDigit (value % 16));

  hueRamp = hue:
    ((hue % 60) * 255) / 60;

  colorFromHue = hue:
    if hue < 60 then
      "#" + (hexByte 255) + (hexByte (hueRamp hue)) + (hexByte 0)
    else if hue < 120 then
      "#" + (hexByte (255 - (hueRamp hue))) + (hexByte 255) + (hexByte 0)
    else if hue < 180 then
      "#" + (hexByte 0) + (hexByte 255) + (hexByte (hueRamp hue))
    else if hue < 240 then
      "#" + (hexByte 0) + (hexByte (255 - (hueRamp hue))) + (hexByte 255)
    else if hue < 300 then
      "#" + (hexByte (hueRamp hue)) + (hexByte 0) + (hexByte 255)
    else
      "#" + (hexByte 255) + (hexByte 0) + (hexByte (255 - (hueRamp hue)));

  drawBall = ball: {
    kind = "circle";
    x = ball.x;
    y = ball.y;
    radius = 15;
    color = colorFromHue ball.hue;
  };

  draw =
    if state.started then
    [
      {
        kind = "clear";
        color = "#0b0d10";
      },
      (drawBall state.balls.0),
      (drawBall state.balls.1),
      (drawBall state.balls.2),
      (drawBall state.balls.3),
      (drawBall state.balls.4),
      (drawBall state.balls.5),
      (drawBall state.balls.6),
      (drawBall state.balls.7),
      (drawBall state.balls.8),
      (drawBall state.balls.9),
      {
        kind = "text";
        x = state.textX;
        y = state.textY;
        text = "Mix canvas loop";
        size = 16;
        color = "#ff9f43";
      },
      {
        kind = "text";
        x = 16;
        y = 225;
        text = "WASD moves the orange text";
        size = 13;
        color = "#858d9c";
      }
    ]
    else
    [
      {
        kind = "clear";
        color = "#0b0d10";
      },
      {
        kind = "text";
        x = 280;
        y = 112;
        text = "Press Space To Start";
        size = 22;
        align = "center";
        color = "#ff9f43";
      },
      {
        kind = "text";
        x = 280;
        y = 142;
        text = "Your timing seeds the simulation";
        size = 13;
        align = "center";
        color = "#858d9c";
      }
    ];
}`;
