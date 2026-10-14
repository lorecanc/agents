export function sum(nums) {
  if (!Array.isArray(nums) || nums.some((n) => typeof n !== "number")) {
    throw new TypeError("nums must be an array of numbers")
  }
  return nums.reduce((a, b) => a + b, 0)
}

export function average(nums) {
  if (!Array.isArray(nums) || nums.some((n) => typeof n !== "number")) {
    throw new TypeError("nums must be an array of numbers")
  }
  return sum(nums) / nums.length
}

export function max(nums) {
  if (!Array.isArray(nums) || nums.some((n) => typeof n !== "number")) {
    throw new TypeError("nums must be an array of numbers")
  }
  return Math.max(...nums)
}
