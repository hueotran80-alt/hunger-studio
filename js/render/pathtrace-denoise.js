import { DenoiseMaterial } from 'three-gpu-pathtracer';

export function createDenoiseMaterial(map) {
  const material = new DenoiseMaterial({ map, sigma: 2, kSigma: 1, threshold: 0.1 });
  // The vendor filters premultiplied RGB; PNG needs straight RGB and unchanged coverage.
  material.fragmentShader = material.fragmentShader.replace('#include <tonemapping_fragment>', `
    gl_FragColor.rgb = gl_FragColor.a > 0.0 ? gl_FragColor.rgb / gl_FragColor.a : vec3(0.0);
    gl_FragColor.a = texture2D(map, vUv).a;
    #include <tonemapping_fragment>
  `);
  return material;
}
